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
- **Ingress Domain**: Exposed at `oc.o.wingu.se`.
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
- **Ingress & mTLS**: The code-server sidecar runs on port 8080 and is exposed via the domain `hmc.o.wingu.se`, protected by the same mTLS gateway/policy as the primary Hermes Agent dashboard (`hm.o.wingu.se`).
- **Network Isolation**: The code-server sidecar's port 8080 is restricted using a Kubernetes `NetworkPolicy` resource (enabled by default). This policy limits ingress on port 8080 specifically to Traefik ingress proxy pods in the `kube-system` namespace and internal loopback/pod-to-pod communication.

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
  - **Dashboard**: Exposed on a dedicated domain (e.g. `omni.o.wingu.se` via `OMNIROUTE_DOMAIN`) and protected with client cert mTLS verification.
  - **LLM API Route**: Exposed on a separate domain (e.g. `omni-api.o.wingu.se` via `OMNIROUTE_API_DOMAIN`) without mTLS to allow seamless API access.

## 9. Forward Auth Service (FAS) & Browser Deployment
- **Dedicated Namespaces**: FAS is deployed to its own namespace (configurable via `FAS_NAMESPACE`, defaulting to `fas`). Browser is deployed to its own namespace (configurable via `BROWSER_NAMESPACE`, defaulting to `browser`).
- **FAS Admin & mTLS**: The FAS admin dashboard is exposed on `a.o.wingu.se` (via `FAS_DOMAIN`) and protected with client certificate mTLS verification.
- **FAS Network Policy**: Port 8080 ingress to FAS is strictly restricted to Traefik ingress proxy pods in the `kube-system` namespace and internal namespace pod-to-pod communication via a Kubernetes `NetworkPolicy`.
- **Browser Service & FAS ForwardAuth Integration**: The Browser service (`ghcr.io/winguse/browser`) is exposed on `s.o.wingu.se` (via `BROWSER_DOMAIN`). Its Ingress uses the Traefik `ForwardAuth` Middleware CRD provided by FAS (`fas-fas-auth@kubernetescrd`) to authenticate incoming user requests before routing to the application.
- **Browser Egress Network Policy Isolation**: The Browser service is isolated via a Kubernetes `NetworkPolicy` resource (`networkpolicy.yaml`). Egress is strictly restricted to public internet IPs (`0.0.0.0/0`) and DNS resolution (`kube-dns`), explicitly denying egress access to internal private network CIDRs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and cloud metadata `169.254.0.0/16`).


## 10. Container Image Version Management & Upgrade Workflow
- **Explicit Version Tagging**: All local Helm chart definitions (`Chart.yaml`), values files (`values.yaml`), and environment configurations (`default.yaml.gotmpl`) must explicitly specify non-`latest` image tags (e.g. semver or release tags). Avoid using `:latest` tags in deployment manifests.
- **Automated Update Tooling (Docker-free)**: Use the repository script `./scripts/check_image_updates.sh` to check or update container image versions. The script queries OCI/Docker v2 APIs directly across GHCR, Docker Hub, MCR, and `registry.k8s.io` using standard `curl` and `jq` without requiring a local Docker daemon.
  - **Check Mode**: `./scripts/check_image_updates.sh` or `./scripts/check_image_updates.sh --check`
  - **Auto-Update Mode (All Charts)**: `./scripts/check_image_updates.sh --update`
  - **Auto-Update Single Chart**: `./scripts/check_image_updates.sh --update <chart_name>` (e.g. `./scripts/check_image_updates.sh --update omniroute`)
- **Version Upgrade Workflow**:
  1. Run `./scripts/check_image_updates.sh --check` to view current vs upstream versions.
  2. Run `./scripts/check_image_updates.sh --update` (or `./scripts/check_image_updates.sh --update <chart_name>`) to automatically rewrite `Chart.yaml`, `values.yaml`, and `default.yaml.gotmpl` with the latest tags and run `helm lint` validation.
  3. Deploy updates using `helmfile apply` (or trigger rolling updates using `kubectl rollout restart deployment/<name>`).



