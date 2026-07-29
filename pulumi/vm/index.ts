import * as pulumi from "@pulumi/pulumi";
import * as oci from "@pulumi/oci";
import * as https from "https";

// ---------------------------------------------------------------------------
// Helper: fetch SSH public keys from GitHub
// ---------------------------------------------------------------------------
function getGithubSshKeys(username: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    https
      .get(`https://github.com/${username}.keys`, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const keys = data.trim().split("\n").map(k => k.trim()).filter(k => k.length > 0);
            if (keys.length === 0) {
              reject(new Error(`No SSH keys found for GitHub user "${username}"`));
            } else {
              resolve(keys);
            }
          } else {
            reject(new Error(`Failed to fetch keys for GitHub user "${username}": HTTP ${res.statusCode}`));
          }
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const config = new pulumi.Config();

const compartmentId  = config.require("compartmentId");
const githubUsername = config.get("githubUsername") ?? "winguse";
const shape          = config.get("shape")          ?? "VM.Standard.E2.1.Micro";
// 1/8 OCPU — E5 Flex supports fractional OCPUs down to 0.125
const ocpus          = config.getNumber("ocpus")         ?? 0.125;
const memoryInGbs    = config.getNumber("memoryInGbs")   ?? 1;
const instanceName   = config.get("instanceName")        ?? "amd-micro-vm";

// ---------------------------------------------------------------------------
// Dynamic lookups: AD + platform image + SSH keys
// ---------------------------------------------------------------------------

// Pick the first Availability Domain in the tenancy/compartment
const adName = oci.identity
  .getAvailabilityDomains({ compartmentId })
  .then(res => {
    if (!res.availabilityDomains || res.availabilityDomains.length === 0) {
      throw new Error("No availability domains found in the specified compartment/region");
    }
    return res.availabilityDomains[0].name;
  });

// Find the latest Canonical Ubuntu 24.04 platform image for AMD (x86_64).
// OCI publishes these under operatingSystem="Canonical Ubuntu" with version "24.04".
const platformImageId = oci.core
  .getImages({
    compartmentId,
    operatingSystem: "Canonical Ubuntu",
    operatingSystemVersion: "24.04",
    shape,
    sortBy: "TIMECREATED",
    sortOrder: "DESC",
  })
  .then(res => {
    if (!res.images || res.images.length === 0) {
      throw new Error(`No Canonical Ubuntu 24.04 platform images found for shape "${shape}"`);
    }
    // images are sorted newest-first; pick the first (most recent)
    const img = res.images[0];
    pulumi.log.info(`Selected platform image: ${img.displayName} (${img.id})`);
    return img.id;
  });

// ---------------------------------------------------------------------------
// cloud-init user-data
// OCI's Canonical Ubuntu images ship with iptables rules managed by
// /etc/iptables/rules.v4 (and rules.v6) that only allow SSH by default.
// We must explicitly open ports 80 and 443 inside the guest — the OCI
// VCN security list alone is not sufficient.
// ---------------------------------------------------------------------------
const cloudInitUserData = Buffer.from(`#!/bin/bash
set -euo pipefail

# ---- IPv4 iptables ----
# Insert ACCEPT rules for HTTP and HTTPS before any DROP/REJECT catchall.
iptables -I INPUT -p tcp --dport 80  -j ACCEPT -m comment --comment "Allow HTTP"
iptables -I INPUT -p tcp --dport 443 -j ACCEPT -m comment --comment "Allow HTTPS"

# Persist so rules survive reboots (iptables-persistent / netfilter-persistent)
if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save
elif command -v iptables-save &>/dev/null; then
  iptables-save  > /etc/iptables/rules.v4
fi

# ---- IPv6 ip6tables ----
ip6tables -I INPUT -p tcp --dport 80  -j ACCEPT -m comment --comment "Allow HTTP IPv6"
ip6tables -I INPUT -p tcp --dport 443 -j ACCEPT -m comment --comment "Allow HTTPS IPv6"

if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save
elif command -v ip6tables-save &>/dev/null; then
  ip6tables-save > /etc/iptables/rules.v6
fi
`).toString("base64");

// Fetch SSH keys from GitHub (all keys, joined — OCI Instance accepts newline-separated keys)
const sshAuthorizedKeys = getGithubSshKeys(githubUsername).then(keys => keys.join("\n"));

// ---------------------------------------------------------------------------
// Networking — dedicated VCN + public subnet for the standalone VM
// ---------------------------------------------------------------------------
const vcn = new oci.core.Vcn("vm-vcn", {
  compartmentId,
  cidrBlock: "10.10.0.0/24",
  displayName: `${instanceName}-vcn`,
  isIpv6enabled: true,
});

const gateway = new oci.core.InternetGateway("vm-igw", {
  compartmentId,
  vcnId: vcn.id,
  displayName: `${instanceName}-igw`,
  enabled: true,
});

const routeTable = new oci.core.RouteTable("vm-route-table", {
  compartmentId,
  vcnId: vcn.id,
  displayName: `${instanceName}-route-table`,
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

// Security list: SSH (22), HTTP (80), HTTPS (443), ICMP — IPv4 + IPv6
const securityList = new oci.core.SecurityList("vm-security-list", {
  compartmentId,
  vcnId: vcn.id,
  displayName: `${instanceName}-security-list`,
  egressSecurityRules: [
    {
      destination: "0.0.0.0/0",
      protocol: "all",
      destinationType: "CIDR_BLOCK",
    },
  ],
  ingressSecurityRules: [
    // SSH
    {
      protocol: "6",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 22, max: 22 },
      description: "Allow SSH (IPv4)",
    },
    {
      protocol: "6",
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 22, max: 22 },
      description: "Allow SSH (IPv6)",
    },
    // HTTP
    {
      protocol: "6",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 80, max: 80 },
      description: "Allow HTTP (IPv4)",
    },
    {
      protocol: "6",
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 80, max: 80 },
      description: "Allow HTTP (IPv6)",
    },
    // HTTPS
    {
      protocol: "6",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 443, max: 443 },
      description: "Allow HTTPS (IPv4)",
    },
    {
      protocol: "6",
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      tcpOptions: { min: 443, max: 443 },
      description: "Allow HTTPS (IPv6)",
    },
    // ICMP
    {
      protocol: "1",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      description: "Allow ICMP",
    },
    {
      protocol: "58",
      source: "::/0",
      sourceType: "CIDR_BLOCK",
      description: "Allow ICMPv6",
    },
  ],
});

const subnet = new oci.core.Subnet("vm-subnet", {
  compartmentId,
  vcnId: vcn.id,
  cidrBlock: "10.10.0.0/24",
  displayName: `${instanceName}-subnet`,
  routeTableId: routeTable.id,
  securityListIds: [securityList.id],
  // Public subnet — instances get a public IP automatically
  prohibitPublicIpOnVnic: false,
});

// ---------------------------------------------------------------------------
// Compute Instance — AMD E5 Flex, 1/8 OCPU, 1 GB RAM, Ubuntu 24.04
// ---------------------------------------------------------------------------
const instance = new oci.core.Instance("vm-instance", {
  compartmentId,
  availabilityDomain: adName,
  displayName: instanceName,

  // AMD x86_64 flexible shape
  shape,
  shapeConfig: {
    ocpus,
    memoryInGbs,
  },

  sourceDetails: {
    sourceType: "image",
    sourceId: platformImageId,
    // 50 GB boot volume is the OCI minimum; keeps costs minimal
    bootVolumeSizeInGbs: "50",
  },

  createVnicDetails: {
    subnetId: subnet.id,
    assignPublicIp: "true",
    displayName: `${instanceName}-vnic`,
  },

  metadata: {
    ssh_authorized_keys: sshAuthorizedKeys,
    // Base64-encoded cloud-init script that opens ports 80/443 in iptables
    // (required in addition to the OCI security list — Ubuntu images on OCI
    // ship with a restrictive in-guest iptables policy by default).
    user_data: cloudInitUserData,
  },

  // Preserve the instance across Pulumi runs even if the image ID changes
  // (prevents accidental termination when a newer platform image is published)
}, {
  ignoreChanges: ["sourceDetails.sourceId"],
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const instanceId   = instance.id;
export const instanceName_ = instance.displayName;
export const publicIp     = instance.publicIp;
export const privateIp    = instance.privateIp;
export const instanceShape = instance.shape;
export const instanceOcpus = instance.shapeConfig.apply(sc => sc?.ocpus);
export const instanceMemory = instance.shapeConfig.apply(sc => sc?.memoryInGbs);
