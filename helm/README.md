# Kubernetes Deployments with Helmfile

This directory contains the Helm and Helmfile configurations to deploy application workloads and infrastructure services onto the Kubernetes cluster.

## Directory Structure

```
helm/
├── charts/           # Custom local Helm charts
│   └── platform/     # Custom platform helpers (ingress, secret management)
├── environments/     # Environment-level configuration
│   └── default.yaml.gotmpl
├── values/           # Value overrides for each release
│   ├── cert-manager.yaml
│   ├── coder.yaml.gotmpl
│   ├── platform.yaml.gotmpl
│   └── postgresql.yaml.gotmpl
└── helmfile.yaml     # Main Helmfile orchestrator
```

---

## Managed Releases

Our [helmfile.yaml](file:///Users/yingyu/workspace/infra/helm/helmfile.yaml) orchestrates the lifecycle of the following releases:

1. **`traefik`** (`traefik/traefik`): Configures the default ingress controller.
2. **`cert-manager`** (`jetstack/cert-manager`): Manages SSL/TLS certificates with Let's Encrypt.
3. **`postgresql`** (`bitnami/postgresql`): High-performance PostgreSQL datastore used by Coder.
4. **`platform`** ([./charts/platform](file:///Users/yingyu/workspace/infra/helm/charts/platform)): Custom configurations containing our ClusterIssuer, Postgres secrets, OIDC configurations, and wildcards.
5. **`coder`** (`coder-v2/coder`): Self-hosted environment workspace management.

---

## Local Configuration (`.env`)

Before applying changes locally, you must create a `.env` file in the **root** of the repository (based on [.env.example](file:///Users/yingyu/workspace/infra/.env.example)) containing the necessary credentials and secret variables:

```bash
# ACME DNS Configs for wildcard SSL certs
ACME_DNS_DOMAIN="example.com"
ACME_DNS_USERNAME="xxxx"
ACME_DNS_PASSWORD="xxxx"
ACME_DNS_FULLDOMAIN="xxxx"
ACME_DNS_SUBDOMAIN="xxxx"
ACME_DNS_ALLOWFROM="0.0.0.0/0"

# Coder Configurations
CODER_ACCESS_URL="https://coder.example.com"
CODER_OIDC_ISSUER_URL="https://idp.example.com"
CODER_OIDC_CLIENT_ID="xxxx"
CODER_OIDC_CLIENT_SECRET="xxxx"

# Database Configuration
POSTGRES_PASSWORD="xxxx"
```

---

## Operations & Commands

All operations should be run from the **root directory** using the `Makefile` to ensure environment variables are correctly loaded and repos are configured:

### 1. Update Repositories
Sync Helm charts cache from external upstream registries:
```bash
make repos
```

### 2. Check Configuration Diff
Check the difference between the active cluster state and current declarations:
```bash
make helm-diff
```

### 3. Deploy/Sync Releases
Sync all declared releases to the current Kubernetes context:
```bash
make helm-apply

# get svc to see the external ip and point domain to it
kubectl get svc -n kube-system
```

### 4. Remove / Tear Down Releases
Destroy all Helmfile releases on the active cluster context:
```bash
make destroy
```

---

## CI/CD Workflows

CI/CD automation is configured under `.github/workflows/` using manual workflow dispatch:
- **`helm-diff`** (`.github/workflows/helm-diff.yaml`): Runs a dry-run `helmfile diff` against the target environment (e.g., `OKE`).
- **`helm-apply`** (`.github/workflows/helm-apply.yaml`): Runs `helmfile sync` to apply changes after secrets and `acme-dns` secrets are written.
