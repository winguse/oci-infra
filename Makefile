.PHONY: repos helm-apply helm-diff destroy acme-dns-secret

# KUBECTX ?= k3s
#	kubectl config use-context $(KUBECTX)
HELMFILE = set -a && . ./.env && set +a && helmfile -f helm/helmfile.yaml.gotmpl

repos:
	helm repo add jetstack https://charts.jetstack.io 2>/dev/null || true
	helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
	helm repo add coder-v2 https://helm.coder.com/v2 2>/dev/null || true
	helm repo add traefik https://traefik.github.io/charts 2>/dev/null || true
	helm repo update

# Create/update the cert-manager namespace secret required by the ClusterIssuer.
# Register with your ACMEDNS server first; see README.md and .env.example.
acme-dns-secret:
	kubectl get namespace cert-manager >/dev/null 2>&1 || kubectl create namespace cert-manager
	set -a && . ./.env && set +a && \
	printf '{"'"$$COMMON_ACME_DNS_DOMAIN"'":{"username":"'"$$COMMON_ACME_DNS_USERNAME"'","password":"'"$$COMMON_ACME_DNS_PASSWORD"'","fulldomain":"'"$$COMMON_ACME_DNS_FULLDOMAIN"'","subdomain":"'"$$COMMON_ACME_DNS_SUBDOMAIN"'","allowfrom":["'"$$COMMON_ACME_DNS_ALLOWFROM"'"]},"'"$$CODER_ACME_DNS_DOMAIN"'":{"username":"'"$$CODER_ACME_DNS_USERNAME"'","password":"'"$$CODER_ACME_DNS_PASSWORD"'","fulldomain":"'"$$CODER_ACME_DNS_FULLDOMAIN"'","subdomain":"'"$$CODER_ACME_DNS_SUBDOMAIN"'","allowfrom":["'"$$CODER_ACME_DNS_ALLOWFROM"'"]}}' | \
	kubectl create secret generic acme-dns \
		--namespace cert-manager \
		--from-file=acmedns.json=/dev/stdin \
		--dry-run=client -o yaml | kubectl apply -f -

helm-apply: acme-dns-secret repos
	$(HELMFILE) sync

# Requires helm-diff: helm plugin install https://github.com/databus23/helm-diff
helm-diff: repos
	$(HELMFILE) diff

destroy:
	$(HELMFILE) destroy
