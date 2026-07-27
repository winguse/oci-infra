#!/usr/bin/env bash
# ==============================================================================
# Container Image Version Management & Auto-Updater Tool (Docker-free)
# ==============================================================================
# Reads current version tags dynamically from local chart manifests and values.
# Usage:
#   ./scripts/check_image_updates.sh           # Check versions across all charts
#   ./scripts/check_image_updates.sh --update   # Check AND update version tags
#   ./scripts/check_image_updates.sh --update <chart_name>  # Update specific chart
# ==============================================================================

set -euo pipefail

MODE="check"
TARGET_CHART="all"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--update)
      MODE="update"
      if [[ $# -gt 1 && "$2" != -* ]]; then
        TARGET_CHART="$2"
        shift
      fi
      shift
      ;;
    -c|--check)
      MODE="check"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--check | --update [chart_name]]"
      echo "  --check       Display current tag status and available updates (default)"
      echo "  --update      Update Chart.yaml, values.yaml, and default environment files to latest tags"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ANSI Color Codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}=====================================================================${NC}"
echo -e "${CYAN}${BOLD}   Container Image Version Manager & Upgrade Tool (Mode: ${MODE})    ${NC}"
echo -e "${CYAN}${BOLD}=====================================================================${NC}\n"

# Helper function to dynamically extract current tag from file
extract_current_tag() {
  local file="$1"
  local key_pattern="$2"

  if [ ! -f "$file" ]; then
    echo ""
    return
  fi

  if [ "$key_pattern" = "appVersion" ]; then
    grep 'appVersion:' "$file" 2>/dev/null | head -n 1 | sed -E 's/.*appVersion:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d '\r' || echo ""
  elif [ "$key_pattern" = "codeServer" ]; then
    grep -A 4 'codeServer:' "$file" 2>/dev/null | grep 'tag:' | head -n 1 | sed -E 's/.*tag:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d '\r' || echo ""
  elif [ "$key_pattern" = "analyzer" ]; then
    grep -A 5 'analyzer:' "$file" 2>/dev/null | grep 'tag:' | head -n 1 | sed -E 's/.*tag:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d '\r' || echo ""
  elif [ "$key_pattern" = "anonymizer" ]; then
    grep -A 5 'anonymizer:' "$file" 2>/dev/null | grep 'tag:' | head -n 1 | sed -E 's/.*tag:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d '\r' || echo ""
  elif [ "$key_pattern" = "cloudflared" ] || [ "$key_pattern" = "kubectl" ]; then
    grep 'image:' "$file" 2>/dev/null | head -n 1 | sed -E 's/.*:([^"]+)"?.*/\1/' | tr -d '\r' || echo ""
  else
    grep 'tag:' "$file" 2>/dev/null | head -n 1 | sed -E 's/.*tag:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d '\r' || echo ""
  fi
}

# Helper function to update a tag in a target file
replace_in_file() {
  local file="$1"
  local old_val="$2"
  local new_val="$3"
  if [ -f "$file" ] && [ -n "$old_val" ] && [ "$old_val" != "$new_val" ]; then
    sed "s|${old_val}|${new_val}|g" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  fi
}

# Main processing function for each image entry
process_image() {
  local chart_name="$1"
  local registry_type="$2" # ghcr, dockerhub, mcr, k8s
  local repo="$3"
  local tag_key="$4"       # tag key pattern to extract
  local filter_pattern="$5" # regex for tag filtering
  local chart_yaml_path="$6"
  local values_path="$7"
  local default_gotmpl_var="${8:-}" # env var in default.yaml.gotmpl or empty

  if [ "$TARGET_CHART" != "all" ] && [ "$TARGET_CHART" != "$chart_name" ]; then
    return 0
  fi

  # Dynamically extract current tag from local files
  local current_tag
  current_tag=$(extract_current_tag "$values_path" "$tag_key")
  if [ -z "$current_tag" ] && [ -n "$chart_yaml_path" ]; then
    current_tag=$(extract_current_tag "$chart_yaml_path" "appVersion")
  fi

  if [ -z "$current_tag" ]; then
    current_tag="unknown"
  fi

  printf "[%-14s] %-34s (Current: %-14s) " "$chart_name" "$repo" "$current_tag"

  local tags=""
  if [ "$registry_type" = "ghcr" ]; then
    local token
    token=$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" | jq -r '.token // empty' || true)
    if [ -n "$token" ]; then
      tags=$(curl -sL -H "Authorization: Bearer $token" "https://ghcr.io/v2/${repo}/tags/list" | jq -r '.tags[]? // empty' || true)
    fi
  elif [ "$registry_type" = "dockerhub" ]; then
    local tags_json
    tags_json=$(curl -s "https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=50" || true)
    tags=$(echo "$tags_json" | jq -r '.results[].name? // empty' 2>/dev/null || true)
  elif [ "$registry_type" = "mcr" ]; then
    tags=$(curl -sL "https://mcr.microsoft.com/v2/${repo}/tags/list" | jq -r '.tags[]? // empty' || true)
  elif [ "$registry_type" = "k8s" ]; then
    tags=$(curl -sL "https://registry.k8s.io/v2/${repo}/tags/list" | jq -r '.tags[]? // empty' || true)
  fi

  if [ -z "$tags" ]; then
    echo -e "${RED}ERR (Could not query registry tags)${NC}"
    return 0
  fi

  local latest_tag
  if [ "$filter_pattern" = "alpine" ]; then
    latest_tag=$(echo "$tags" | grep -E '^[0-9].*-alpine$' | sort -V | tail -n 1 || true)
  elif [ "$filter_pattern" = "semver" ]; then
    latest_tag=$(echo "$tags" | grep -E '^[vV]?[0-9]+\.[0-9]+' | grep -v -E '(latest|main|beta|rc|-dev)' | sort -V | tail -n 1 || true)
  elif [ "$filter_pattern" = "latest" ]; then
    latest_tag="latest"
  else
    latest_tag=$(echo "$tags" | grep -E '^[vV]?[0-9]' | grep -v -E '(latest|main|amd64|arm64|slim)' | sort -V | tail -n 1 || true)
  fi

  if [ -z "$latest_tag" ]; then
    latest_tag="$current_tag"
  fi

  if [ "$current_tag" = "$latest_tag" ]; then
    echo -e "${GREEN}✓ UP-TO-DATE (${current_tag})${NC}"
  else
    if [ "$MODE" = "update" ]; then
      echo -e "${YELLOW}UPDATING -> ${latest_tag}${NC}"
      
      # Update Chart.yaml if specified
      if [ -n "$chart_yaml_path" ] && [ -f "$chart_yaml_path" ]; then
        replace_in_file "$chart_yaml_path" "appVersion: \"${current_tag}\"" "appVersion: \"${latest_tag}\""
        replace_in_file "$chart_yaml_path" "appVersion: ${current_tag}" "appVersion: \"${latest_tag}\""
      fi
      
      # Update values.yaml if specified
      if [ -n "$values_path" ] && [ -f "$values_path" ]; then
        replace_in_file "$values_path" "${current_tag}" "${latest_tag}"
      fi

      # Update default.yaml.gotmpl if specified
      if [ -n "$default_gotmpl_var" ] && [ -f "helm/environments/default.yaml.gotmpl" ]; then
        replace_in_file "helm/environments/default.yaml.gotmpl" "default \"${current_tag}\"" "default \"${latest_tag}\""
      fi
    else
      echo -e "${YELLOW}➜ UPDATE AVAILABLE (${current_tag} -> ${latest_tag})${NC}"
    fi
  fi
}

echo -e "${CYAN}--- Processing Chart Image Configurations ---${NC}"

process_image "bifrost"        "dockerhub" "maximhq/bifrost"                 "tag"        "semver"  "helm/charts/bifrost/Chart.yaml"        "helm/charts/bifrost/values.yaml"        ""
process_image "browser"        "ghcr"      "winguse/browser"                "tag"        "default" "helm/charts/browser/Chart.yaml"        "helm/charts/browser/values.yaml"        "BROWSER_TAG"
process_image "fas"            "ghcr"      "winguse/fas"                    "tag"        "semver"  "helm/charts/fas/Chart.yaml"            "helm/charts/fas/values.yaml"            "FAS_TAG"
process_image "hermes-agent"  "dockerhub" "nousresearch/hermes-agent"        "tag"        "default" "helm/charts/hermes-agent/Chart.yaml"   "helm/charts/hermes-agent/values.yaml"   ""
process_image "hermes-agent"  "ghcr"      "coder/code-server"              "codeServer" "semver"  ""                                      "helm/charts/hermes-agent/values.yaml"   ""
process_image "litellm"        "ghcr"      "berriai/litellm-database"       "tag"        "semver"  "helm/charts/litellm/Chart.yaml"        "helm/charts/litellm/values.yaml"        ""
process_image "micro-nfs"      "k8s"       "sig-storage/nfs-provisioner"   "tag"        "semver"  "helm/charts/micro-nfs/Chart.yaml"      "helm/charts/micro-nfs/values.yaml"      ""
process_image "omniroute"      "dockerhub" "diegosouzapw/omniroute"         "tag"        "semver"  "helm/charts/omniroute/Chart.yaml"      "helm/charts/omniroute/values.yaml"      "OMNIROUTE_TAG"
process_image "openclaw"       "dockerhub" "openclaw/openclaw"              "tag"        "default" "helm/charts/openclaw/Chart.yaml"       "helm/charts/openclaw/values.yaml"       ""
process_image "platform"       "dockerhub" "cloudflare/cloudflared"         "cloudflared" "semver"  ""                                      "helm/charts/platform/templates/cloudflared.yaml" ""
process_image "presidio"       "mcr"       "presidio-analyzer"              "analyzer"   "semver"  "helm/charts/presidio/Chart.yaml"       "helm/charts/presidio/values.yaml"       "PRESIDIO_ANALYZER_TAG"
process_image "presidio"       "mcr"       "presidio-anonymizer"            "anonymizer" "semver"  ""                                      "helm/charts/presidio/values.yaml"       "PRESIDIO_ANONYMIZER_TAG"
process_image "system-patches" "dockerhub" "bitnami/kubectl"                "kubectl"    "latest"  ""                                      "helm/charts/system-patches/templates/job.yaml" ""
process_image "valkey"         "dockerhub" "valkey/valkey"                  "tag"        "alpine"  "helm/charts/valkey/Chart.yaml"         "helm/charts/valkey/values.yaml"         "VALKEY_TAG"

if [ "$MODE" = "update" ]; then
  echo -e "\n${CYAN}--- Linting Modified Charts ---${NC}"
  for chart_dir in helm/charts/*; do
    if [ -d "$chart_dir" ]; then
      local_chart=$(basename "$chart_dir")
      if [ "$TARGET_CHART" = "all" ] || [ "$TARGET_CHART" = "$local_chart" ]; then
        helm lint "$chart_dir" > /dev/null 2>&1 && echo -e "Lint [${GREEN}PASS${NC}] ${local_chart}" || echo -e "Lint [${RED}FAIL${NC}] ${local_chart}"
      fi
    fi
  done
fi

echo -e "\n${CYAN}${BOLD}=====================================================================${NC}"
if [ "$MODE" = "update" ]; then
  echo -e "${GREEN}${BOLD}Update complete! Target chart versions updated and verified.${NC}"
else
  echo -e "${GREEN}${BOLD}Check complete! Run './scripts/check_image_updates.sh --update' to apply updates.${NC}"
fi
echo -e "${CYAN}${BOLD}=====================================================================${NC}"
