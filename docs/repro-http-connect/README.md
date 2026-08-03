# Envoy forward-proxy CONNECT: HTTP/3 data tunnel not relayed

This reproduction documents and demonstrates a limitation of using the
**Envoy Gateway HTTPS CONNECT forward proxy** (the `gw` chart's
`envoy-connect-proxy`) as a generic TCP tunnel: **HTTP/1.1 and HTTP/2 fully
relay tunneled bytes, but HTTP/3 (QUIC) only authenticates to `200` and then
closes the connection with zero data frames.**

Everything here was verified live against a running Envoy Gateway (EG `v1.8.3`,
Envoy `v1.38.3`) behind a single dual-stack OCI NLB on port 443.

---

## tl;dr

| Transport | CONNECT reply | Tunneled bytes relayed? |
|-----------|---------------|--------------------------|
| HTTP/1.1  | `200`         | ✅ yes                    |
| HTTP/2    | `200`         | ✅ yes                    |
| HTTP/3    | `200`         | ❌ **no** — `DATA(+0)`, then `ConnectionTerminated` |

Expected behaviour for CONNECT (RFC 9110 §9.3.6): after a `2xx` the proxy
switches to tunnel mode and forwards raw bytes bidirectionally. That works for
HTTP/1.1 and HTTP/2, but not for HTTP/3, where Envoy acknowledges the request
and immediately tears the QUIC connection down without relaying any payload.

## Prerequisites

- A reachable Envoy forward proxy on `443` (the `gw` `proxy` must be enabled).
- A valid `Proxy-Authorization` credential. This proxy's basic-auth is
  configured to read the credential from the **`Proxy-Authorization`** header
  (not `Authorization`) via the chart's `EnvoyPatchPolicy`, so clients must
  send that header.
- `go`, `python3`, and `make` on the jump host.

> Note: HTTP/3 CONNECT requests MUST omit the `:scheme` and `:path`
> pseudo-headers. An (even empty) `:path` triggers Envoy
> `http3.invalid_header_field` and the request is dropped. Only
> `:method=CONNECT` + `:authority` are sent — see `py/h3/h3.py`.

## Build

```bash
make build
```

This builds:
- `go/h1/h1` — HTTP/1.1 CONNECT client
- `go/h2/h2` — HTTP/2 CONNECT client
- a Python venv `py/h3/.venv` with `aioquic` for the HTTP/3 CONNECT client

## Run

All three clients CONNECT to `TARGET_HOST:TARGET_PORT` through the proxy.

```bash
# defaults (proxy 170.9.16.247:443, target example.com:80) shown in the Makefile;
# override any of them:
PROXY_HOST=170.9.16.247 PROXY_PORT=443 \
PROXY_AUTH='Basic dXV1OmNlNTNjeFZ1NzZma0RI' \
TARGET_HOST=example.com TARGET_PORT=80 \
    make run-h1

make run-h2   # same variables apply
make run-h3   # same variables apply
make run      # all three in sequence
```

`PROXY_AUTH` is the value sent verbatim in the `Proxy-Authorization` header.

## Interpreting the output

- `make run-h1` → `RESULT: HTTP/1.1 CONNECT tunnels data = true`
- `make run-h2` → reads real bytes back over the h2-stream tunnel (the
  upstream's `HTTP/1.1 200 OK...` response).
- `make run-h3` → `HTTP/3 CONNECT status: 200` but `DATA(+0)` /
  `ConnectionTerminated` / `tunneled data timeout` / `tunnels data = False`.

## Root-cause notes (for the maintainer)

- The HTTP/3 failure is **not an auth problem** — the proxy returns `200`
  only after valid `Proxy-Authorization`, so routing + the 
  `authentication_header: Proxy-Authorization` patch work on the QUIC
  listener.
- The QUIC EnvoyPatchPolicy in the chart targets the **UDP data listener**
  `envoy-quic/https-quic` (NOT the TCP sibling `envoy-quic/https`). If it
  points at `.../envoy-quic/https`, the patch lands on the wrong listener and
  HTTP/3 silently falls back to the default `Authorization` header → `401`.
- `http3_protocol_options.allow_extended_connect: true` on the QUIC listener
  enables Envoy to accept the extended CONNECT framing, but does **not**
  enable payload relay; that is a separate capability Envoy has not landed for
  HTTP/3 CONNECT data streams.
- Workaround: consume the proxy over **HTTP/1.1 or HTTP/2** (e.g. force
  `curl --http1.1 -x https://...` / `--http2`). For HTTP/3 do not rely on
  CONNECT-based distribution.

## Layout

```
docs/repro-http-connect/
├── Makefile             # build + run targets (run-h1/h2/h3, run, clean)
└── go/
    ├── h1/main.go        # HTTP/1.1 CONNECT client (working data tunnel)
    └── h2/main.go        # HTTP/2 CONNECT client (working data tunnel)
└── py/
    └── h3/
        ├── h3.py         # HTTP/3 CONNECT client (auth ok, no data relay)
        └── requirements.txt
```