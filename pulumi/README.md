# Infrastructure Provisioning with Pulumi

This directory contains our infrastructure provisioning modules for Oracle Cloud Infrastructure (OCI). We have divided our setups into separate, independent modules so that they can be run separately.

## Modules

- [oke](file:///Users/yingyu/workspace/infra/pulumi/oke): An OCI Container Engine for Kubernetes (OKE) managed cluster utilizing `VM.Standard.A1.Flex` worker nodes with automated control-plane management.
- [vm](./vm): A standalone AMD-based Compute VM (`VM.Standard.E5.Flex`) with 1/8 OCPU and 1 GB memory — ideal for lightweight workloads. Includes a dedicated VCN/subnet with public IP and SSH access via GitHub keys.

## Usage

Navigate to either module subdirectory to install dependencies and run:

```bash
npm install
pulumi stack init dev
pulumi up

# output kubeconfig
pulumi stack output kubeconfigContent --cwd pulumi/oke > ~/.kube/config
```
