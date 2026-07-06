import * as pulumi from "@pulumi/pulumi";
import * as oci from "@pulumi/oci";
import * as https from "https";

// Helper function to dynamically fetch SSH public keys from GitHub
function getGithubSshKeys(username: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(`https://github.com/${username}.keys`, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data.trim());
        } else {
          reject(new Error(`Failed to fetch keys for GitHub user "${username}": HTTP ${res.statusCode}`));
        }
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

// Load configurations
const config = new pulumi.Config();
const compartmentId = config.require("compartmentId");
const githubUsername = config.get("githubUsername") ?? "winguse";

// Create a dedicated compartment for all OKE resources to isolate and limit scope
const okeCompartment = new oci.identity.Compartment("oke-compartment", {
  compartmentId: compartmentId, // Parent compartment (root tenancy ID)
  description: "Dedicated compartment for OKE cluster and related resources",
  name: "oke-compartment",
});

// Instance configurations
const shape = config.get("shape") ?? "VM.Standard.A1.Flex";
const ocpus = config.getNumber("ocpus") ?? 2;
const memoryInGbs = config.getNumber("memoryInGbs") ?? 12;
const nodePoolSize = config.getNumber("nodePoolSize") ?? 1;

// Fetch the GitHub SSH keys (taking only the first one as OKE NodePool accepts a single valid OpenSSH key)
const sshKeys = getGithubSshKeys(githubUsername).then(keys => {
  const list = keys.split("\n").map(k => k.trim()).filter(k => k.length > 0);
  if (list.length === 0) {
    throw new Error(`No SSH keys found for GitHub user "${githubUsername}"`);
  }
  return list[0];
});

// Get the Availability Domains dynamically
const ads = oci.identity.getAvailabilityDomains({ compartmentId });
const adName = ads.then(res => {
  if (!res.availabilityDomains || res.availabilityDomains.length === 0) {
    throw new Error("No availability domains found in the specified compartment/region");
  }
  return res.availabilityDomains[0].name;
});

// Fetch OKE Node Pool options to find compatible K8s version and ARM image
const nodePoolOption = oci.containerengine.getNodePoolOption({
  nodePoolOptionId: "all",
  compartmentId: compartmentId,
});

// Resolve both the OKE image ID and its corresponding Kubernetes version together
// to guarantee they match exactly and avoid 409 conflict errors.
const resolvedConfig = nodePoolOption.then(opt => {
  const sources = opt.sources || [];
  const versions = opt.kubernetesVersions || [];

  // Filter for OKE-specific ARM (aarch64) images
  const armOkeSources = sources.filter(s => 
    s.sourceName.toLowerCase().includes("aarch64") && 
    s.sourceName.toLowerCase().includes("oke")
  );

  if (armOkeSources.length === 0) {
    throw new Error("No ARM (aarch64) OKE worker node images found in region options");
  }

  // Find a source whose Kubernetes version matches a supported cluster version
  for (const source of armOkeSources) {
    const match = source.sourceName.match(/OKE-([0-9]+\.[0-9]+\.[0-9]+)/i);
    if (match) {
      const k8sVer = `v${match[1]}`;
      if (versions.includes(k8sVer)) {
        pulumi.log.info(`Selected OKE Image: ${source.sourceName} with Kubernetes Version: ${k8sVer}`);
        return {
          imageId: source.imageId,
          kubernetesVersion: k8sVer,
        };
      }
    }
  }

  // Fallback: Pick the first ARM OKE source, extract version, and hope for the best
  const firstSource = armOkeSources[0];
  const match = firstSource.sourceName.match(/OKE-([0-9]+\.[0-9]+\.[0-9]+)/i);
  const k8sVer = match ? `v${match[1]}` : (versions[0] || "v1.33.0");
  pulumi.log.warn(`No exact version match found. Falling back to Image: ${firstSource.sourceName} with Version: ${k8sVer}`);
  return {
    imageId: firstSource.imageId,
    kubernetesVersion: k8sVer,
  };
});

const k8sVersion = resolvedConfig.then(c => c.kubernetesVersion);
const imageId = resolvedConfig.then(c => c.imageId);

// Create OCI Networking Resources for OKE
const vcn = new oci.core.Vcn("oke-vcn", {
  compartmentId: okeCompartment.id,
  cidrBlock: "10.0.0.0/16",
  displayName: "oke-vcn",
  isIpv6enabled: false,
});

const gateway = new oci.core.InternetGateway("oke-gateway", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  displayName: "oke-gateway",
  enabled: true,
});

const routeTable = new oci.core.RouteTable("oke-route-table", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  displayName: "oke-route-table",
  routeRules: [
    {
      destination: "0.0.0.0/0",
      destinationType: "CIDR_BLOCK",
      networkEntityId: gateway.id,
    },
  ],
});

// Security list enabling API, SSH, HTTP, HTTPS, and full internal access
const securityList = new oci.core.SecurityList("oke-security-list", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  displayName: "oke-security-list",
  egressSecurityRules: [
    {
      destination: "0.0.0.0/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
  ],
  ingressSecurityRules: [
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 22, max: 22 },
      description: "Allow SSH",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 6443, max: 6443 },
      description: "Allow Kubernetes API",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 80, max: 80 },
      description: "Allow HTTP",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 443, max: 443 },
      description: "Allow HTTPS",
    },
    {
      protocol: "all",
      source: "10.0.0.0/16",
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN traffic",
    },
  ],
});

// Regional Subnets for OKE Components
const endpointSubnet = new oci.core.Subnet("oke-endpoint-subnet", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  cidrBlock: "10.0.1.0/24",
  displayName: "oke-endpoint-subnet",
  routeTableId: routeTable.id,
  securityListIds: [securityList.id],
});

const nodeSubnet = new oci.core.Subnet("oke-node-subnet", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  cidrBlock: "10.0.2.0/24",
  displayName: "oke-node-subnet",
  routeTableId: routeTable.id,
  securityListIds: [securityList.id],
});

const lbSubnet = new oci.core.Subnet("oke-lb-subnet", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  cidrBlock: "10.0.3.0/24",
  displayName: "oke-lb-subnet",
  routeTableId: routeTable.id,
  securityListIds: [securityList.id],
});

// Create OKE Cluster
const cluster = new oci.containerengine.Cluster("oke-cluster", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  kubernetesVersion: k8sVersion,
  name: "oke-cluster",
  endpointConfig: {
    subnetId: endpointSubnet.id,
    isPublicIpEnabled: true,
  },
  options: {
    serviceLbSubnetIds: [lbSubnet.id],
    kubernetesNetworkConfig: {
      podsCidr: "10.244.0.0/16",
      servicesCidr: "10.96.0.0/16",
    },
  },
});

// Create OKE Node Pool
const nodePool = new oci.containerengine.NodePool("oke-nodepool", {
  clusterId: cluster.id,
  compartmentId: okeCompartment.id,
  name: "oke-nodepool",
  kubernetesVersion: k8sVersion,
  nodeShape: shape,
  nodeShapeConfig: {
    ocpus: ocpus,
    memoryInGbs: memoryInGbs,
  },
  nodeSourceDetails: {
    sourceType: "IMAGE",
    imageId: imageId,
  },
  nodeConfigDetails: {
    size: nodePoolSize,
    placementConfigs: [
      {
        availabilityDomain: adName,
        subnetId: nodeSubnet.id,
      },
    ],
  },
  sshPublicKey: sshKeys,
});

// OCI Dynamic Group to identify OKE worker node instances in the compartment
const autoscalerGroup = new oci.identity.DynamicGroup("oke-autoscaler-group", {
  compartmentId: compartmentId, // Must be tenancy ID
  description: "Dynamic group for OKE worker nodes used by Cluster Autoscaler",
  matchingRule: pulumi.interpolate`instance.compartment.id = '${okeCompartment.id}'`,
  name: "oke-autoscaler-group",
});

// OCI Policy to grant the Dynamic Group permission to manage OKE cluster node pools
const autoscalerPolicy = new oci.identity.Policy("oke-autoscaler-policy", {
  compartmentId: compartmentId,
  description: "IAM Policy to allow OKE worker nodes in dynamic group to manage cluster node pools for autoscaling",
  name: "oke-autoscaler-policy",
  statements: [
    pulumi.interpolate`Allow dynamic-group id ${autoscalerGroup.id} to manage cluster-family in compartment id ${okeCompartment.id}`,
    pulumi.interpolate`Allow dynamic-group id ${autoscalerGroup.id} to manage instance-family in compartment id ${okeCompartment.id}`,
    pulumi.interpolate`Allow dynamic-group id ${autoscalerGroup.id} to use virtual-network-family in compartment id ${okeCompartment.id}`,
  ],
});

// Export Outputs
export const clusterId = cluster.id;
export const nodePoolId = nodePool.id;
export const dynamicGroupName = autoscalerGroup.name;
export const policyName = autoscalerPolicy.name;
export const kubeconfigContent = cluster.id.apply(cid => 
  oci.containerengine.getClusterKubeConfig({
    clusterId: cid,
  }).then(res => res.content)
);
