# H2O Forward Proxy: Protocol Analysis & FAS Authentication Integration

This document records the architecture, authentication integration with FAS (Forward Auth Service), and comprehensive test results across HTTP/1.1, HTTP/2, and HTTP/3 for the H2O forward proxy deployed in the cluster.

---

## 1. Overview & Architecture

H2O is deployed as a high-performance HTTP forward proxy supporting TCP and UDP/QUIC (HTTP/3) termination under `h2o.i.wingu.se`.

* **Workload**: Kubernetes `StatefulSet` in namespace `h2o` (image: `ghcr.io/winguse/h2o:v20260804`).
* **TLS Termination**: Native TLS termination via cert-manager wildcard certificate (`*.i.wingu.se`) mounted at `/etc/h2o/tls/`.
* **Port Bindings**:
  * Port `8080` (TCP): Plain HTTP listener (redirects 301 to HTTPS).
  * Port `8443` (TCP): TLS listener for HTTP/1.1 and HTTP/2.
  * Port `8443` (UDP): QUIC listener for HTTP/3 (`type: quic`).
* **Authentication**: Fully integrated with FAS (`http://fas.fas.svc.cluster.local:8080/_auth`) via an H2O `mruby` handler interceptor (`h2o-auth-fas.rb`).

---

## 2. Protocol Support Matrix

| Protocol / Mode | Handshake / Auth | Tunneled Bytes Relayed? | Status | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **HTTP/2 (`h2`) CONNECT** | `200 OK` via FAS | ✅ **Yes (Full Bidirectional Relay)** | ✅ **Production Ready** | Fully functional with FAS auth; verified with curl & proxy clients |
| **HTTP/1.1 Forward Proxy** (`GET http://...`) | `200 OK` via FAS | ✅ **Yes** | ✅ **Supported** | Cleartext HTTP proxying with FAS auth |
| **HTTP/1.1 CONNECT** (`CONNECT host:443`) | ❌ `405 Method Not Allowed` | ❌ No | ⚠️ **Engine Limitation with mruby** | H2O's `lib/http1.c` requires direct socket hijacking and does not support chaining Rack-based `mruby` middleware in front of `proxy.connect` |
| **HTTP/3 (`h3`) CONNECT** | `200 OK` via FAS | ❌ No (`DATA(+0)`) | ⚠️ **Engine & OCI NLB Limitation** | FAS authenticates to `200`, but H2O QUIC CONNECT data relaying yields 0 bytes; OCI CCM also drops UDP-443 on dual-protocol single-service NLB |

---

## 3. FAS Authentication Integration Flow

H2O intercepts incoming requests with `mruby.handler-file: /etc/h2o/h2o-auth-fas.rb`:

1. **Header Forwarding**:
   * Extracts all client `HTTP_*` headers (including `Proxy-Authorization`, `Authorization`, `Cookie`, `User-Agent`).
   * Appends `X-Forwarded-For` with client IP, `X-Forwarded-Method` with request method (`CONNECT`, `GET`, etc.), and `X-Forwarded-Host` with target authority.
2. **Subrequest to FAS**:
   * Dispatches an asynchronous subrequest: `http_request("http://fas.fas.svc.cluster.local:8080/_auth" + path, ...)`
3. **Decision Handling**:
   * **FAS `200 OK`**: Returns status `399` to H2O to allow and delegate the request to the next handler (`proxy.connect` / `proxy.connect-udp`).
   * **FAS Non-200** (e.g. `401`, `403`, `409`, `302`): Immediately returns the FAS status code, challenge headers, and body back to the client.

---

## 4. Empirical Test Results & Verification

### A. HTTP/2 CONNECT (Working & Verified)

```bash
curl -v --proxy-http2 \
  --proxy-header "Proxy-Authorization: Basic dXV1OjVhY2YzODJiLTc0MTEtNDg0Yi1iNzYwLTIxMGJiYzI0YjNjNA==" \
  -x https://h2o.i.wingu.se:443 \
  https://httpbin.org/ip
```

**Output**:
```
* ALPN: server accepted h2
* CONNECT tunnel: HTTP/2 negotiated
* Establish HTTP/2 proxy tunnel to httpbin.org:443
* CONNECT tunnel established, response 200
* TLS handshake completed with upstream
< HTTP/2 200
{
  "origin": "192.9.156.241"
}
```

* **Invalid Credentials Test**:
  Sending invalid credentials returns denial from FAS (stream reset / challenge) and prevents unauthorized tunneling.

---

### B. HTTP/1.1 CONNECT (mruby Middleware Behavior)

1. **With `proxy.connect` alone (no mruby)**:
   * Returns `HTTP/1.1 200 OK` and relays bytes bidirectionally.
2. **With `mruby` FAS auth interceptor in front of `proxy.connect`**:
   * H2O's HTTP/1.1 parser in `lib/http1.c` treats `CONNECT` as an immediate raw file-descriptor takeover. It does not permit intermediate Rack-based middleware on HTTP/1.1 connections and immediately responds with `HTTP/1.1 405 Method Not Allowed`.
   * Conversely, HTTP/2 multiplexes streams into frames, allowing mruby to inspect headers, call FAS, and delegate to `proxy.connect` cleanly.

---

### C. HTTP/3 (QUIC) In-Cluster & Dedicated Pulumi NLB Analysis

1. **Dedicated Pulumi OCI NLB Path (`oke-h2o-nlb` on `150.230.44.55:443`)**:
   * Resolved the OCI CCM limitation (`oracle/oci-cloud-controller-manager#532`) by provisioning a dedicated dual-stack OCI NLB via Pulumi (`oke-h2o-nlb`).
   * Explicitly exposes UDP port 443 mapped to NodePort 32491, enabling public UDP/QUIC ingress directly.
   * **Live Test Output via `aioquic`**:
     ```python
     connecting to 150.230.44.55:443 (SNI=h2o.i.wingu.se) via QUIC...
       [quic] stream 0 data_end=False
       [h3] HEADERS status=b'200'
     sending tunneled GET...
       [h3] DATA(+0): b''
       [h3] tunneled data timeout (no bytes relayed)

     ===== RESULT =====
     HTTP/3 CONNECT status: b'200'
     HTTP/3 tunneled bytes received: 0
     HTTP/3 CONNECT tunnels data = False
     ```
   * **Result**: Public UDP 443 network routing, QUIC handshake, TLS SNI negotiation, and FAS authentication all succeed (`HTTP/3 200`). However, like Envoy, H2O's current HTTP/3 engine acknowledges CONNECT requests with `200` but does not relay tunneled stream bytes.

---

## 5. Summary & Client Recommendations

1. **Clients connecting over HTTPS proxy should use HTTP/2**:
   * Modern forward proxy clients, browsers, Clash/Shadowrocket/Surge, Go transports, and curl (`--proxy-http2`) negotiate HTTP/2 with H2O, providing authenticated proxying via FAS and full data throughput.
2. **Legacy HTTP/1.1 CONNECT clients**:
   * If a client strictly requires HTTP/1.1 CONNECT tunnels, route traffic through the Envoy Gateway forward proxy (`gw` chart on port 443 with basic auth), which handles HTTP/1.1 CONNECT natively.
