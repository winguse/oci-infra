do not read credentials file `.env`, when coding only use `.env.example`

# Project Learnings & Behavioral Guidelines

## 1. Project Context & Tooling
- **Orchestration**: The project uses **Helmfile** to orchestrate local charts and community helm charts on an OKE cluster.
- **Local Charts**: Custom charts are stored under `helm/charts/`.
- **Configuration Flow**: Environment defaults are in `default.yaml.gotmpl`, with chart-specific overrides in `helm/values/`.

## 2. Storage over Storage (NFS Provisioner)
- **Problem**: OCI Block Volumes have a minimum size limit (50GB).
- **Solution**: Use `micro-nfs` provisioner to share folders as smaller PVCs dynamically over a single large OCI Block Volume.
- **Container Capabilities**: NFS provisioners require `DAC_READ_SEARCH` and `SYS_RESOURCE` capabilities.
- **Service Bindings**: Require `SERVICE_NAME` and `POD_IP` for endpoint validation.
- **Resource Limits**: To prevent unchecked memory usage, the `micro-nfs` pod is constrained with a CPU request of `50m` (no CPU limit) and matching memory request/limits (defaulting to `256Mi`), configurable via `MICRO_NFS_CPU` and `MICRO_NFS_MEMORY_LIMIT`.

## 3. OpenClaw mTLS Gateway
- **Ingress Domain**: Exposed at `oc.i.wingu.se`.
- **mTLS Security**: Protected via client certificate verification.
- **Config Initialization**: Requires configuration bootstrapping via an initContainer to run successfully.

## 4. Best Practices for Modifying the Project
- **Linting**: Always validate local Helm chart templates using `helm lint helm/charts/<chart_name>` after updates.
- **Configurations**: Propagate parameters from `default.yaml.gotmpl` down to the chart values via `helm/values/<chart>.yaml.gotmpl`.
- **Image Registries**: All container images in Helm templates or values files must explicitly specify the registry/source host prefix.
- **Documentation**: Keep this `AGENTS.md` file up to date with new architectural decisions and operational rules.

## 5. Hermes Agent & Code-Server Sidecar
- **Sidecar Integration**: `hermes-agent` features a `code-server` sidecar container (image: `ghcr.io/coder/code-server:4.17.1`) to provide an IDE interface. For permission compatibility on shared NFS data volumes, the sidecar is configured to run as `coder` (UID 10000 / GID 10000) and sets `HOME=/opt/data` to maintain persistency.
- **Shared Data**: The main container and the sidecar share the `data` volume. For `code-server`, it is mounted to `/opt/data` to persist user workspaces and configuration.
- **Ingress & mTLS**: The code-server sidecar runs on port 8080 and is exposed via the domain `hmc.i.wingu.se`, protected by the same mTLS gateway/policy as the primary Hermes Agent dashboard (`hm.i.wingu.se`).
- **Network Isolation**: The code-server sidecar's port 8080 is restricted using a Kubernetes `NetworkPolicy` resource (enabled by default). This policy limits ingress on port 8080 specifically to Envoy ingress proxy pods in the `kube-system` namespace and internal loopback/pod-to-pod communication.

## 6. Shared PostgreSQL Deployment
- **Dedicated Namespace**: The PostgreSQL server is deployed in a dedicated namespace (configurable via `POSTGRES_NAMESPACE`, defaulting to `postgres`) to separate it from the `coder` workspace/namespace.
- **Cross-Namespace Sharing**: Other cluster services connect to the shared PostgreSQL instance using the fully qualified domain name (FQDN): `postgresql.<postgres-namespace>.svc.cluster.local:5432`.
- **Database/User Initialization**: Multiple databases and users are dynamically initialized on first start using the Bitnami PostgreSQL chart's `primary.initdb.scripts` block, controlled via the `postgresql.extraDatabases` list configuration in `default.yaml.gotmpl`.

## 7. Microsoft Presidio Deployment (Analyzer & Anonymizer)
- **Dedicated Namespace**: Deployed in a dedicated namespace (configurable via `PRESIDIO_NAMESPACE`, defaulting to `presidio`) to keep them isolated from other workloads.
- **Components**: Separated into `presidio-analyzer` and `presidio-anonymizer` deployments/services, exposing their REST APIs internally on port `3000`.
- **LiteLLM Integration**: Integrated with the LiteLLM proxy for PII detection/guardrails by passing the `PRESIDIO_ANALYZER_API_BASE` and `PRESIDIO_ANONYMIZER_API_BASE` environment variables to the LiteLLM deployment.

## 8. OmniRoute AI Gateway & Valkey Deployment
- **Dedicated Namespaces**: OmniRoute is deployed to its own namespace (configurable via `OMNIROUTE_NAMESPACE`, defaulting to `omniroute`). Valkey is also deployed to its own namespace (configurable via `VALKEY_NAMESPACE`, defaulting to `valkey`) to keep workloads isolated.
- **Cross-Namespace Sharing**: OmniRoute connects to the Valkey service across namespaces using the FQDN: `valkey.<valkey-namespace>.svc.cluster.local:6379`.
- **Secret Generation**: Credentials and API keys (such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.) are configured via `.env` / `.env.example` and loaded into the `omniroute-secrets` Kubernetes Secret using the Makefile's `omniroute-secrets` target.
- **Dual Domain Routing & mTLS**: OmniRoute is exposed via two separate Ingresses:
  - **Dashboard**: Exposed on a dedicated domain (e.g. `omni.i.wingu.se` via `OMNIROUTE_DOMAIN`) and protected with client cert mTLS verification.
  - **LLM API Route**: Exposed on a separate domain (e.g. `omni-api.i.wingu.se` via `OMNIROUTE_API_DOMAIN`) without mTLS to allow seamless API access.

## 9. Forward Auth Service (FAS) & Browser Deployment
- **Dedicated Namespaces**: FAS is deployed to its own namespace (configurable via `FAS_NAMESPACE`, defaulting to `fas`). Browser is deployed to its own namespace (configurable via `BROWSER_NAMESPACE`, defaulting to `browser`).
- **FAS Admin & mTLS**: The FAS admin dashboard is exposed on `a.i.wingu.se` (via `FAS_DOMAIN`) and protected with client certificate mTLS verification.
- **FAS Network Policy**: Port 8080 ingress to FAS is strictly restricted to Envoy ingress proxy pods in the `kube-system` namespace and internal namespace pod-to-pod communication via a Kubernetes `NetworkPolicy`.
- **Browser Service & FAS ForwardAuth Integration**: The Browser service (`ghcr.io/winguse/browser`) is exposed on `s.i.wingu.se` (via `BROWSER_DOMAIN`). Its Ingress integrates with FAS to authenticate incoming user requests before routing to the application.
- **Browser Egress Network Policy Isolation**: The Browser service is isolated via a Kubernetes `NetworkPolicy` resource (`networkpolicy.yaml`). Egress is strictly restricted to public internet IPs (`0.0.0.0/0`) and DNS resolution (`kube-dns`), explicitly denying egress access to internal private network CIDRs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and cloud metadata `169.254.0.0/16`).


## 10. Container Image Version Management & Upgrade Workflow
- **Single Source of Truth**: Container image configurations (registry, repository, tag) are defined solely within each local chart's `helm/charts/<chart_name>/values.yaml` and `Chart.yaml` (`appVersion`). Avoid adding redundant `image:` overrides in `default.yaml.gotmpl` or `helm/values/<chart>.yaml.gotmpl`.
- **Explicit Version Tagging**: All local Helm chart definitions (`Chart.yaml`) and values files (`values.yaml`) must explicitly specify non-`latest` image tags (e.g. semver or release tags). Avoid using `:latest` tags in deployment manifests.
- **Automated Update Tooling (Docker-free)**: Use `./scripts/check_image_updates.sh` to check or update container image versions. The script queries OCI/Docker v2 APIs directly across GHCR, Docker Hub, MCR, and `registry.k8s.io` using standard `curl` and `jq` without requiring a local Docker daemon.
  - **Check Mode**: `./scripts/check_image_updates.sh` or `./scripts/check_image_updates.sh --check`
  - **Auto-Update Mode (All Charts)**: `./scripts/check_image_updates.sh --update`
  - **Auto-Update Single Chart**: `./scripts/check_image_updates.sh --update <chart_name>` (e.g. `./scripts/check_image_updates.sh --update omniroute`)
- **Version Upgrade Workflow**:
  1. Run `./scripts/check_image_updates.sh --check` to view current vs upstream versions.
  2. Run `./scripts/check_image_updates.sh --update` (or `./scripts/check_image_updates.sh --update <chart_name>`) to automatically rewrite `Chart.yaml` and `values.yaml` with the latest tags and run `helm lint` validation.
  3. Deploy updates using `make helm-apply` (or trigger rolling updates using `kubectl rollout restart deployment/<name>`).

## 11. Single-Gateway Envoy Architecture (HTTP/3 over UDP + mTLS over TCP, one NLB)
- **Problem**: Envoy Gateway enables HTTP/3 (QUIC) for the entire port-443 xDS listener if ANY HTTPS section on that port has `http3` set, and QUIC does not support downstream client-cert validation. mTLS and HTTP/3 therefore cannot coexist on the same port-443 TCP listener. Additionally, OCI NLBs cannot mix protocols on one listener, so a single NLB must expose TCP-443 and UDP-443 as separate listeners.
- **Solution**: Two EnvoyProxies but a **single NLB + single DNS IP**, splitting the traffic plane by protocol (not by gateway):
  - `envoy-config` EnvoyProxy (TCP plane): nodePorts 31080 (HTTP), 31332 (HTTPS). Serves BOTH public and mTLS traffic on port 443.
  - `envoy-quic-config` EnvoyProxy (UDP plane): nodePort 31344 (HTTPS UDP/QUIC), plus a dedicated TCP health nodePort 31345 mapped to the envoy readiness listener (19003). Serves public HTTP/3 only.
  - The main `envoy` Gateway (gatewayClassName `envoy`, parametersRef `envoy-config`) exposes listeners `http` (80), `https` (443 catch-all, no hostname, ALPN http/1.1+h2), plus mTLS sections `https-mtls-a` (a.i.wingu.se), `https-mtls-hm` (hm.i.wingu.se), `https-mtls-hmc` (hmc.i.wingu.se), `https-mtls-omni` (omni.i.wingu.se), `https-mtls-oc` (oc.i.wingu.se), each with a `ClientTrafficPolicy` doing `clientValidation.caCertificateRefs: mtls-ca-bundle` AND explicit `alpnProtocols: [http/1.1, h2]`.
  - The `envoy-quic` Gateway (parametersRef `envoy-quic-config`) exposes a single `https` (443, catch-all) listener with `ClientTrafficPolicy envoy-quic-https-http3` (`http3: {}`).
- **mTLS + HTTP/1.1 downgrade pitfall**: overlapping hostnames (catch-all `https` + hostname-specific mTLS sections) set `TLSOverlaps`, which forces ALPN to `["http/1.1"]` **unless** `alpnProtocols` is explicitly set. ALWAYS set explicit `alpnProtocols: [http/1.1, h2]` on any ClientTrafficPolicy targeting overlapping listeners.
- **Alt-Svc advertising**: Public HTTPRoutes (browser, litellm, platform coder, omniroute API) attach to BOTH the `envoy` gateway (section `https`) and the `envoy-quic` gateway (section `https`), with a `ResponseHeaderModifier` filter setting `alt-svc: 'h3=":443"; ma=86400'` on the TCP gateway route. This tells browsers to upgrade to HTTP/3 on UDP-443 (same IP), while the mTLS routes (fas, hermes-agent, openclaw, omniroute dashboard) only attach to `envoy` section `https-mtls-*`.
- **NodePorts (must be cluster-unique)**: 31080 (HTTP TCP), 31332 (HTTPS TCP), 31344 (HTTPS UDP/QUIC), 31345 (TCP, quic health → readiness 19003). All must be open in the OCI node security list (`pulumi/oke/index.ts`, IPv4 + IPv6). No `healthCheckNodePort` (LoadBalancer-only) is used.
- **Service Patch**: Envoy Service ports are patched with `type: JSONMerge` (RFC 7386) because strategic merge on `spec.ports` keys on `port` only (ignores protocol) and mangles the port list (e.g. renames `https`→`https-mtls-a`, drops nodePorts).
- **FAS Auth**: FAS is integrated via the browser's route-level `SecurityPolicy` (extAuth→fas). There is no gateway-level FAS extAuth policy anymore; do not re-add one.
- **Pulumi NLB**: A single dual-stack `oci.networkloadbalancer.NetworkLoadBalancer` (`oke-ingress-nlb`, `nlbIpVersion: IPV4_AND_IPV6`) with six FIVE_TUPLE backend sets (http-v4/v6→31080, https-v4/v6→31332, quic-v4/v6→31344, `isPreserveSource: true`) and six listeners (TCP:80, TCP:443, UDP:443 × IPv4/IPv6) is created by pulumi (not by the CCM). Backends are per-node private IPs (IPv4 = `nodes.privateIp`, IPv6 = VNIC `ipv6addresses[0]`).
- **Pulumi backend set pitfall**: Backend sets MUST use `oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified` with inline `backends`. The plain `BackendSet` + separate `Backend` resources cannot update `healthChecker` (OCI rejects `backends[0].port must not be null`).
- **NLB health checks**: target TCP ports that respond on the node — the main plane's data nodePorts (31080/31332) directly, and the quic plane's TCP health nodePort (31345). A TCP probe against the UDP-only quic data port (31344) always fails.
- **CCM NLBs are NOT used**: Both EnvoyProxies use `envoyService.type: NodePort` (no `oci.oraclecloud.com/load-balancer-type` annotations). The pulumi NLB is the only load balancer; do not re-add LoadBalancer-type annotations or the CCM will provision extra NLBs.
- **Static backends & node changes**: The pulumi NLB backends are a static per-node list filtered to `state === "ACTIVE"` at plan time (`activeNodes` in `pulumi/oke/index.ts`), so they only reconcile on `pulumi up`. After scaling the node pool, run `make nlb-sync` to refresh NLB backends (this runs `pulumi up` on the `oke` stack). Deleting a node without syncing leaves a stale backend that OCI reports as WARNING. The CCM is not used because its 1-NLB-per-Service model merges same-port multi-protocol into one listener (see `oracle/oci-cloud-controller-manager#532`), which cannot split TCP-443 vs UDP-443 across two Envoy Services.

