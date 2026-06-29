do not read credentials file `.env`, when coding only use `.env.example`

# Project Learnings & Behavioral Guidelines

## 1. Project Context & Tooling
- **Orchestration**: The project uses **Helmfile** (`helm/helmfile.yaml.gotmpl`) to orchestrate local charts and community helm charts on an Oracle Kubernetes Engine (OKE) cluster.
- **Local Charts**: Custom charts are stored under [helm/charts/](helm/charts) (e.g., `platform`, `micro-nfs`).
- **Configuration Flow**: 
  - Environment defaults are configured in [helm/environments/default.yaml.gotmpl](helm/environments/default.yaml.gotmpl).
  - Specific value overrides are written in [helm/values/](helm/values).

## 2. Storage over Storage (NFS Provisioner)
- **Problem**: OCI Block Volumes have a hard minimum size limit of 50GB.
- **Solution**: The `micro-nfs` local chart provisions a single large OCI Block Volume (100GB via class `oci-bv`) and runs an in-cluster Ganesha NFS Server Provisioner (`registry.k8s.io/sig-storage/nfs-provisioner:v4.0.8`) over it, dynamically sharing folders as smaller PVCs (e.g., 2GB) under the custom `micro-nfs` StorageClass.
- **Mandatory Container Capabilities**: Ganesha requires `DAC_READ_SEARCH` and `SYS_RESOURCE` capabilities to mount and export volumes.
- **Service Bindings**: The container requires `SERVICE_NAME` and `POD_IP` env vars to match the single endpoint Service configuration for network validation.

## 3. Best Practices for Modifying the Project
- **Linting**: Always validate local Helm chart templates using `helm lint helm/charts/<chart_name>` after updates.
- **Configurations**: When introducing new parameters, propagate them from `default.yaml.gotmpl` down to the chart values via `helm/values/<chart>.yaml.gotmpl`.
- **Image Registries**: All container images in Helm templates or values files must explicitly specify the registry/source host (e.g., `docker.io/` prefix for Docker Hub images, `registry.k8s.io/` for Kubernetes SIG storage, etc.). Do not use short repository names without a registry prefix.
- **Documentation**: Keep this `AGENTS.md` file up to date with new architectural decisions and operational rules.

