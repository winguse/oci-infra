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

// Helper function to dynamically construct a /64 subnet prefix from VCN's /56 prefix
function getSubnetIpv6(vcnIpv6Cidr: string | undefined, subnetIndex: number): string | undefined {
  if (!vcnIpv6Cidr) {
    return undefined;
  }
  const base = vcnIpv6Cidr.split("/")[0];
  const parts = base.split(":");
  const prefixGroup = parts[3] || "0000";
  const prefixGroupBase = prefixGroup.slice(0, 2);
  const subnetHex = subnetIndex.toString(16).padStart(2, "0");
  parts[3] = prefixGroupBase + subnetHex;
  return parts.join(":") + "/64";
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

  // Sort sources by extracted version descending so we always pick the newest available
  armOkeSources.sort((a, b) => {
    const matchA = a.sourceName.match(/OKE-([0-9]+\.[0-9]+\.[0-9]+)/i);
    const matchB = b.sourceName.match(/OKE-([0-9]+\.[0-9]+\.[0-9]+)/i);
    const verA = matchA ? matchA[1] : "0.0.0";
    const verB = matchB ? matchB[1] : "0.0.0";
    
    // 1. Compare Kubernetes versions first
    const k8sCompare = verB.localeCompare(verA, undefined, { numeric: true, sensitivity: 'base' });
    if (k8sCompare !== 0) {
      return k8sCompare;
    }
    
    // 2. If K8s versions are equal, fallback to sorting by the full source name descending.
    // This ensures newer host images (which embed dates like 2024.11.20) are prioritized.
    return b.sourceName.localeCompare(a.sourceName, undefined, { numeric: true, sensitivity: 'base' });
  });

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
  isIpv6enabled: true,
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
    {
      destination: "::/0",
      destinationType: "CIDR_BLOCK",
      networkEntityId: gateway.id,
    },
  ],
});

// Security list enabling API, SSH, HTTP, HTTPS, and full internal access
// Security list for Kubernetes API Endpoint
const endpointSecurityList = new oci.core.SecurityList("oke-endpoint-security-list", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  displayName: "oke-endpoint-security-list",
  egressSecurityRules: [
    {
      destination: "0.0.0.0/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
    {
      destination: "::/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
  ],
  ingressSecurityRules: [
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 6443, max: 6443 },
      description: "Allow Kubernetes API",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 6443, max: 6443 },
      description: "Allow Kubernetes API IPv6",
    },
    {
      protocol: "58", // ICMPv6
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      description: "Allow ICMPv6 traffic",
    },
    {
      protocol: "all",
      source: "10.0.0.0/16",
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN traffic",
    },
    {
      protocol: "all",
      source: vcn.ipv6cidrBlocks.apply(blocks => blocks && blocks.length > 0 ? blocks[0] : "::/0"),
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN IPv6 traffic",
    },
  ],
});

// Security list for Load Balancer Subnet (handles public incoming HTTP/HTTPS/HTTP3 traffic)
const lbSecurityList = new oci.core.SecurityList("oke-lb-security-list", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  displayName: "oke-lb-security-list",
  egressSecurityRules: [
    {
      destination: "0.0.0.0/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
    {
      destination: "::/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
  ],
  ingressSecurityRules: [
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 80, max: 80 },
      description: "Allow HTTP",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 80, max: 80 },
      description: "Allow HTTP IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 443, max: 443 },
      description: "Allow HTTPS",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 443, max: 443 },
      description: "Allow HTTPS IPv6",
    },
    {
      protocol: "17", // UDP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      udpOptions: { min: 443, max: 443 },
      description: "Allow HTTP/3 (QUIC) UDP",
    },
    {
      protocol: "17", // UDP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      udpOptions: { min: 443, max: 443 },
      description: "Allow HTTP/3 (QUIC) UDP IPv6",
    },
    {
      protocol: "58", // ICMPv6
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      description: "Allow ICMPv6 traffic",
    },
    {
      protocol: "all",
      source: "10.0.0.0/16",
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN traffic",
    },
    {
      protocol: "all",
      source: vcn.ipv6cidrBlocks.apply(blocks => blocks && blocks.length > 0 ? blocks[0] : "::/0"),
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN IPv6 traffic",
    },
  ],
});

// Security list for Host Nodes Subnet
const nodeSecurityList = new oci.core.SecurityList("oke-node-security-list", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  displayName: "oke-node-security-list",
  egressSecurityRules: [
    {
      destination: "0.0.0.0/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
    {
      destination: "::/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
  ],
  ingressSecurityRules: [
    {
      protocol: "6", // TCP
      source: "10.0.0.0/16",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 22, max: 22 },
      description: "Allow SSH internally from VCN",
    },
    {
      protocol: "6", // TCP
      source: vcn.ipv6cidrBlocks.apply(blocks => blocks && blocks.length > 0 ? blocks[0] : "::/0"),
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 22, max: 22 },
      description: "Allow SSH IPv6 internally from VCN",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 31080, max: 31080 },
      description: "Allow Envoy HTTP NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 31080, max: 31080 },
      description: "Allow Envoy HTTP NodePort IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 31332, max: 31332 },
      description: "Allow Envoy HTTPS NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 31332, max: 31332 },
      description: "Allow Envoy HTTPS NodePort IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 31345, max: 31345 },
      description: "Allow Envoy QUIC Health NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 31345, max: 31345 },
      description: "Allow Envoy QUIC Health NodePort IPv6",
    },
    {
      protocol: "17", // UDP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      udpOptions: { min: 31344, max: 31344 },
      description: "Allow Envoy HTTP/3 (QUIC) NodePort",
    },
    {
      protocol: "17", // UDP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      udpOptions: { min: 31344, max: 31344 },
      description: "Allow Envoy HTTP/3 (QUIC) NodePort IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32080, max: 32080 },
      description: "Allow Traefik HTTP NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32080, max: 32080 },
      description: "Allow Traefik HTTP NodePort IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32443, max: 32443 },
      description: "Allow Traefik HTTPS NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32443, max: 32443 },
      description: "Allow Traefik HTTPS NodePort IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32090, max: 32090 },
      description: "Allow H2O HTTP NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32090, max: 32090 },
      description: "Allow H2O HTTP NodePort IPv6",
    },
    {
      protocol: "6", // TCP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32490, max: 32490 },
      description: "Allow H2O HTTPS NodePort",
    },
    {
      protocol: "6", // TCP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 32490, max: 32490 },
      description: "Allow H2O HTTPS NodePort IPv6",
    },
    {
      protocol: "17", // UDP
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      udpOptions: { min: 32491, max: 32491 },
      description: "Allow H2O HTTPS (QUIC) UDP NodePort",
    },
    {
      protocol: "17", // UDP
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      udpOptions: { min: 32491, max: 32491 },
      description: "Allow H2O HTTPS (QUIC) UDP NodePort IPv6",
    },
    {
      protocol: "58", // ICMPv6
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      description: "Allow ICMPv6 traffic",
    },
    {
      protocol: "all",
      source: "10.0.0.0/16",
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN traffic",
    },
    {
      protocol: "all",
      source: vcn.ipv6cidrBlocks.apply(blocks => blocks && blocks.length > 0 ? blocks[0] : "::/0"),
      sourceType: "CIDR_BLOCK",
      description: "Allow all internal VCN IPv6 traffic",
    },
  ],
});

// Regional Subnets for OKE Components
const endpointSubnet = new oci.core.Subnet("oke-endpoint-subnet", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  cidrBlock: "10.0.1.0/24",
  ipv6cidrBlock: vcn.ipv6cidrBlocks.apply(blocks => getSubnetIpv6(blocks && blocks.length > 0 ? blocks[0] : undefined, 1)),
  displayName: "oke-endpoint-subnet",
  routeTableId: routeTable.id,
  securityListIds: [endpointSecurityList.id],
});

const nodeSubnet = new oci.core.Subnet("oke-node-subnet", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  cidrBlock: "10.0.2.0/24",
  ipv6cidrBlock: vcn.ipv6cidrBlocks.apply(blocks => getSubnetIpv6(blocks && blocks.length > 0 ? blocks[0] : undefined, 2)),
  displayName: "oke-node-subnet",
  routeTableId: routeTable.id,
  securityListIds: [nodeSecurityList.id],
});

const lbSubnet = new oci.core.Subnet("oke-lb-subnet", {
  compartmentId: okeCompartment.id,
  vcnId: vcn.id,
  cidrBlock: "10.0.3.0/24",
  ipv6cidrBlock: vcn.ipv6cidrBlocks.apply(blocks => getSubnetIpv6(blocks && blocks.length > 0 ? blocks[0] : undefined, 3)),
  displayName: "oke-lb-subnet",
  routeTableId: routeTable.id,
  securityListIds: [lbSecurityList.id],
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
    ipFamilies: ["IPv4", "IPv6"],
    kubernetesNetworkConfig: {
      podsCidr: "10.244.0.0/16",
      servicesCidr: "10.96.0.0/16",
    },
  },
}, {
  ignoreChanges: [
    "options.kubernetesNetworkConfig.podsCidr",
    "options.kubernetesNetworkConfig.servicesCidr",
  ],
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

// Resolve worker node IP addresses (IPv4 + IPv6) for NLB backend sets.
// Node pool nodes expose IPv4 via the nodepool; IPv6 is resolved through the
// instance's VNIC attachments.
const nodePoolLookup = oci.containerengine.getNodePoolOutput({
  nodePoolId: nodePool.id,
});
// Only ACTIVE nodes become NLB backends: OKE nodepools keep DELETED nodes in
// the `nodes` list after the autoscaler scales down, and a stale backend for a
// terminated instance shows as a WARNING/unhealthy backend on the NLB.
const activeNodes = nodePoolLookup.nodes.apply(nodes => nodes.filter(n => n.state === "ACTIVE"));
const nodeIpv4s = activeNodes.apply(nodes =>
  nodes.map(n => n.privateIp).filter(ip => ip && ip.length > 0)
);
const nodeIpv6s = pulumi.all([okeCompartment.id, activeNodes]).apply(async ([compartmentId, nodes]) => {
  const ipv6s: string[] = [];
  for (const node of nodes) {
    const attachments = await oci.core.getVnicAttachments({
      compartmentId: compartmentId,
      instanceId: node.id,
    });
    for (const att of attachments.vnicAttachments || []) {
      const vnic = await oci.core.getVnic({ vnicId: att.vnicId });
      if (vnic.ipv6addresses && vnic.ipv6addresses.length > 0) {
        ipv6s.push(vnic.ipv6addresses[0]);
      }
    }
  }
  return ipv6s;
});

// Reserved Public IP for the main Ingress NLB (Envoy)
const ingressReservedIp = new oci.core.PublicIp("oke-ingress-reserved-ip", {
  compartmentId: okeCompartment.id,
  displayName: "oke-ingress-reserved-ip",
  lifetime: "RESERVED",
});

// Single public dual-stack Network Load Balancer for all inbound traffic.
// TCP-80/TCP-443 hit the main Envoy (HTTP/2, redirect + all routes incl. mTLS);
// UDP-443 (QUIC) hits the dedicated HTTP/3 Envoy. One public IP for everything.
const ingressNlb = new oci.networkloadbalancer.NetworkLoadBalancer("oke-ingress-nlb", {
  compartmentId: okeCompartment.id,
  displayName: "oke-ingress-nlb",
  subnetId: lbSubnet.id,
  subnetIpv6cidr: lbSubnet.ipv6cidrBlock,
  isPrivate: false,
  nlbIpVersion: "IPV4_AND_IPV6",
  reservedIps: [{
    id: ingressReservedIp.id,
  }],
}, { deleteBeforeReplace: true });

// Backend sets mirror the CCM pattern: one per IP version per port.
// Policy FIVE_TUPLE + isPreserveSource=true match the CCM-managed NLBs.
const healthCheckerTcp = (port: pulumi.Input<number>) => ({
  protocol: "TCP",
  port: port,
  intervalInMillis: 10000,
  retries: 3,
  timeoutInMillis: 3000,
});

// NLB health checks must target TCP ports that respond on the node. The main
// Envoy's data nodePorts (31080/31332) are TCP, so they are checked directly.
// The QUIC Envoy's data nodePort (31344) is UDP-only (a TCP probe always fails),
// so the quic EnvoyProxy exposes a dedicated TCP health nodePort (31345) mapped
// to its readiness listener (19003).
const HEALTH_CHECK_PORT_HTTP = 31080;
const HEALTH_CHECK_PORT_HTTPS = 31332;
const HEALTH_CHECK_PORT_QUIC = 31345;

// Backends must be declared inline on the BackendSet (not as separate Backend
// resources): updating a BackendSet requires the full backend list with ports,
// and standalone Backend resources are not visible to that update call.
const backendListV4 = (port: number): pulumi.Output<oci.types.input.NetworkLoadBalancer.NetworkLoadBalancersBackendSetsUnifiedBackend[]> =>
  nodeIpv4s.apply(ips => ips.map(ip => ({ ipAddress: ip, port })));
const backendListV6 = (port: number): pulumi.Output<oci.types.input.NetworkLoadBalancer.NetworkLoadBalancersBackendSetsUnifiedBackend[]> =>
  nodeIpv6s.apply(ips => ips.map(ip => ({ ipAddress: ip, port })));

// Backend sets (unified: inline backends) mirror the CCM pattern, one per IP
// version per port. Using the unified resource (instead of BackendSet + separate
// Backend resources) is required: updating a plain BackendSet's healthChecker
// fails because it cannot see standalone Backend resources on the OCI side.
const bsHttpV4 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-http-v4", {
  networkLoadBalancerId: ingressNlb.id,
  name: "bs-http-v4",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV4",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_HTTP),
  backends: backendListV4(31080),
}, { deleteBeforeReplace: true });
const bsHttpV6 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-http-v6", {
  networkLoadBalancerId: ingressNlb.id,
  name: "bs-http-v6",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV6",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_HTTP),
  backends: backendListV6(31080),
}, { deleteBeforeReplace: true });
const bsHttpsV4 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-https-v4", {
  networkLoadBalancerId: ingressNlb.id,
  name: "bs-https-v4",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV4",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_HTTPS),
  backends: backendListV4(31332),
}, { deleteBeforeReplace: true });
const bsHttpsV6 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-https-v6", {
  networkLoadBalancerId: ingressNlb.id,
  name: "bs-https-v6",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV6",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_HTTPS),
  backends: backendListV6(31332),
}, { deleteBeforeReplace: true });
const bsQuicV4 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-quic-v4", {
  networkLoadBalancerId: ingressNlb.id,
  name: "bs-quic-v4",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV4",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_QUIC),
  backends: backendListV4(31344),
}, { deleteBeforeReplace: true });
const bsQuicV6 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-quic-v6", {
  networkLoadBalancerId: ingressNlb.id,
  name: "bs-quic-v6",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV6",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_QUIC),
  backends: backendListV6(31344),
}, { deleteBeforeReplace: true });

// Listeners: one per protocol x IP version.
const listenerHttpV4 = new oci.networkloadbalancer.Listener("listener-http-v4", {
  networkLoadBalancerId: ingressNlb.id,
  name: "http-v4",
  protocol: "TCP",
  port: 80,
  defaultBackendSetName: bsHttpV4.name,
  ipVersion: "IPV4",
}, { deleteBeforeReplace: true, dependsOn: [bsHttpV4] });
const listenerHttpV6 = new oci.networkloadbalancer.Listener("listener-http-v6", {
  networkLoadBalancerId: ingressNlb.id,
  name: "http-v6",
  protocol: "TCP",
  port: 80,
  defaultBackendSetName: bsHttpV6.name,
  ipVersion: "IPV6",
}, { deleteBeforeReplace: true, dependsOn: [bsHttpV6] });
const listenerHttpsV4 = new oci.networkloadbalancer.Listener("listener-https-v4", {
  networkLoadBalancerId: ingressNlb.id,
  name: "https-v4",
  protocol: "TCP",
  port: 443,
  defaultBackendSetName: bsHttpsV4.name,
  ipVersion: "IPV4",
}, { deleteBeforeReplace: true, dependsOn: [bsHttpsV4] });
const listenerHttpsV6 = new oci.networkloadbalancer.Listener("listener-https-v6", {
  networkLoadBalancerId: ingressNlb.id,
  name: "https-v6",
  protocol: "TCP",
  port: 443,
  defaultBackendSetName: bsHttpsV6.name,
  ipVersion: "IPV6",
}, { deleteBeforeReplace: true, dependsOn: [bsHttpsV6] });
const listenerQuicV4 = new oci.networkloadbalancer.Listener("listener-quic-v4", {
  networkLoadBalancerId: ingressNlb.id,
  name: "quic-v4",
  protocol: "UDP",
  port: 443,
  defaultBackendSetName: bsQuicV4.name,
  ipVersion: "IPV4",
}, { deleteBeforeReplace: true, dependsOn: [bsQuicV4] });
const listenerQuicV6 = new oci.networkloadbalancer.Listener("listener-quic-v6", {
  networkLoadBalancerId: ingressNlb.id,
  name: "quic-v6",
  protocol: "UDP",
  port: 443,
  defaultBackendSetName: bsQuicV6.name,
  ipVersion: "IPV6",
}, { deleteBeforeReplace: true, dependsOn: [bsQuicV6] });

// Reserved Public IP for the H2O forward proxy NLB
const h2oReservedIp = new oci.core.PublicIp("oke-h2o-reserved-ip", {
  compartmentId: okeCompartment.id,
  displayName: "oke-h2o-reserved-ip",
  lifetime: "RESERVED",
});

// Single public dual-stack Network Load Balancer for H2O forward proxy.
// Splits TCP-80, TCP-443, and UDP-443 (HTTP/3 QUIC) cleanly using unified backend sets.
const h2oNlb = new oci.networkloadbalancer.NetworkLoadBalancer("oke-h2o-nlb", {
  compartmentId: okeCompartment.id,
  displayName: "oke-h2o-nlb",
  subnetId: lbSubnet.id,
  subnetIpv6cidr: lbSubnet.ipv6cidrBlock,
  isPrivate: false,
  nlbIpVersion: "IPV4_AND_IPV6",
  reservedIps: [{
    id: h2oReservedIp.id,
  }],
}, { deleteBeforeReplace: true });

const HEALTH_CHECK_PORT_H2O_HTTP = 32090;
const HEALTH_CHECK_PORT_H2O_HTTPS = 32490;

const bsH2oHttpV4 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-h2o-http-v4", {
  networkLoadBalancerId: h2oNlb.id,
  name: "bs-h2o-http-v4",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV4",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_H2O_HTTP),
  backends: backendListV4(32090),
}, { deleteBeforeReplace: true });
const bsH2oHttpV6 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-h2o-http-v6", {
  networkLoadBalancerId: h2oNlb.id,
  name: "bs-h2o-http-v6",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV6",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_H2O_HTTP),
  backends: backendListV6(32090),
}, { deleteBeforeReplace: true });
const bsH2oHttpsV4 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-h2o-https-v4", {
  networkLoadBalancerId: h2oNlb.id,
  name: "bs-h2o-https-v4",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV4",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_H2O_HTTPS),
  backends: backendListV4(32490),
}, { deleteBeforeReplace: true });
const bsH2oHttpsV6 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-h2o-https-v6", {
  networkLoadBalancerId: h2oNlb.id,
  name: "bs-h2o-https-v6",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV6",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_H2O_HTTPS),
  backends: backendListV6(32490),
}, { deleteBeforeReplace: true });
const bsH2oQuicV4 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-h2o-quic-v4", {
  networkLoadBalancerId: h2oNlb.id,
  name: "bs-h2o-quic-v4",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV4",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_H2O_HTTPS),
  backends: backendListV4(32491),
}, { deleteBeforeReplace: true });
const bsH2oQuicV6 = new oci.networkloadbalancer.NetworkLoadBalancersBackendSetsUnified("bs-h2o-quic-v6", {
  networkLoadBalancerId: h2oNlb.id,
  name: "bs-h2o-quic-v6",
  policy: "FIVE_TUPLE",
  isPreserveSource: true,
  ipVersion: "IPV6",
  healthChecker: healthCheckerTcp(HEALTH_CHECK_PORT_H2O_HTTPS),
  backends: backendListV6(32491),
}, { deleteBeforeReplace: true });

// H2O Listeners: one per protocol x IP version.
const listenerH2oHttpV4 = new oci.networkloadbalancer.Listener("listener-h2o-http-v4", {
  networkLoadBalancerId: h2oNlb.id,
  name: "http-v4",
  protocol: "TCP",
  port: 80,
  defaultBackendSetName: bsH2oHttpV4.name,
  ipVersion: "IPV4",
}, { deleteBeforeReplace: true, dependsOn: [bsH2oHttpV4] });
const listenerH2oHttpV6 = new oci.networkloadbalancer.Listener("listener-h2o-http-v6", {
  networkLoadBalancerId: h2oNlb.id,
  name: "http-v6",
  protocol: "TCP",
  port: 80,
  defaultBackendSetName: bsH2oHttpV6.name,
  ipVersion: "IPV6",
}, { deleteBeforeReplace: true, dependsOn: [bsH2oHttpV6] });
const listenerH2oHttpsV4 = new oci.networkloadbalancer.Listener("listener-h2o-https-v4", {
  networkLoadBalancerId: h2oNlb.id,
  name: "https-v4",
  protocol: "TCP",
  port: 443,
  defaultBackendSetName: bsH2oHttpsV4.name,
  ipVersion: "IPV4",
}, { deleteBeforeReplace: true, dependsOn: [bsH2oHttpsV4] });
const listenerH2oHttpsV6 = new oci.networkloadbalancer.Listener("listener-h2o-https-v6", {
  networkLoadBalancerId: h2oNlb.id,
  name: "https-v6",
  protocol: "TCP",
  port: 443,
  defaultBackendSetName: bsH2oHttpsV6.name,
  ipVersion: "IPV6",
}, { deleteBeforeReplace: true, dependsOn: [bsH2oHttpsV6] });
const listenerH2oQuicV4 = new oci.networkloadbalancer.Listener("listener-h2o-quic-v4", {
  networkLoadBalancerId: h2oNlb.id,
  name: "quic-v4",
  protocol: "UDP",
  port: 443,
  defaultBackendSetName: bsH2oQuicV4.name,
  ipVersion: "IPV4",
}, { deleteBeforeReplace: true, dependsOn: [bsH2oQuicV4] });
const listenerH2oQuicV6 = new oci.networkloadbalancer.Listener("listener-h2o-quic-v6", {
  networkLoadBalancerId: h2oNlb.id,
  name: "quic-v6",
  protocol: "UDP",
  port: 443,
  defaultBackendSetName: bsH2oQuicV6.name,
  ipVersion: "IPV6",
}, { deleteBeforeReplace: true, dependsOn: [bsH2oQuicV6] });

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
export const vcnIpv6CidrBlocks = vcn.ipv6cidrBlocks;
export const nodeSubnetIpv4Cidr = nodeSubnet.cidrBlock;
export const nodeSubnetIpv6Cidr = nodeSubnet.ipv6cidrBlock;
export const kubeconfigContent = cluster.id.apply(cid => 
  oci.containerengine.getClusterKubeConfig({
    clusterId: cid,
  }).then(res => res.content)
);
export const ingressNlbId = ingressNlb.id;
export const ingressNlbPublicIps = ingressNlb.ipAddresses;
export const ingressReservedIpAddress = ingressReservedIp.ipAddress;
export const h2oNlbId = h2oNlb.id;
export const h2oNlbPublicIps = h2oNlb.ipAddresses;
export const h2oReservedIpAddress = h2oReservedIp.ipAddress;
