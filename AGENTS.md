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

## 3. OpenClaw mTLS Gateway
- **Ingress Domain**: Exposed at `oc.o.wingu.se`.
- **mTLS Security**: Protected via client certificate verification.
- **Config Initialization**: Requires configuration bootstrapping via an initContainer to run successfully.

## 4. Best Practices for Modifying the Project
- **Linting**: Always validate local Helm chart templates using `helm lint helm/charts/<chart_name>` after updates.
- **Configurations**: Propagate parameters from `default.yaml.gotmpl` down to the chart values via `helm/values/<chart>.yaml.gotmpl`.
- **Image Registries**: All container images in Helm templates or values files must explicitly specify the registry/source host prefix.
- **Documentation**: Keep this `AGENTS.md` file up to date with new architectural decisions and operational rules.
