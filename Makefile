.PHONY: repos helm-apply helm-diff destroy nlb-sync acme-dns-secret hermes-secrets openclaw-secrets omniroute-secrets proxy-secrets init-shared-db

ENV ?=
ENV_FILE ?= $(if $(ENV),.env.$(ENV),.env)
LOAD_ENV = set -a && [ -f ./$(ENV_FILE) ] && . ./$(ENV_FILE) && set +a

# KUBECTX ?= k3s
#	kubectl config use-context $(KUBECTX)
HELMFILE = $(LOAD_ENV) || true; helmfile -f helm/helmfile.yaml.gotmpl

repos:
	helm repo add jetstack https://charts.jetstack.io 2>/dev/null || true
	helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
	helm repo add coder-v2 https://helm.coder.com/v2 2>/dev/null || true
	helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ 2>/dev/null || true
	helm repo update

# Create/update the cert-manager namespace secret required by the ClusterIssuer.
# Register with your ACMEDNS server first; see README.md and .env.example.
acme-dns-secret:
	kubectl get namespace cert-manager >/dev/null 2>&1 || kubectl create namespace cert-manager
	$(LOAD_ENV) || true; \
	COMMON_DOMAIN=$${COMMON_ACME_DNS_DOMAIN:-i.wingu.se} && \
	COMMON_USER=$${COMMON_ACME_DNS_USERNAME:-not-important} && \
	COMMON_ALLOW=$${COMMON_ACME_DNS_ALLOWFROM:-0.0.0.0/0} && \
	CODER_DOMAIN=$${CODER_ACME_DNS_DOMAIN:-coder.i.wingu.se} && \
	CODER_USER=$${CODER_ACME_DNS_USERNAME:-not-important} && \
	CODER_ALLOW=$${CODER_ACME_DNS_ALLOWFROM:-0.0.0.0/0} && \
	printf '{"'"$$COMMON_DOMAIN"'":{"username":"'"$$COMMON_USER"'","password":"'"$$COMMON_ACME_DNS_PASSWORD"'","fulldomain":"'"$$COMMON_ACME_DNS_FULLDOMAIN"'","subdomain":"'"$$COMMON_ACME_DNS_SUBDOMAIN"'","allowfrom":["'"$$COMMON_ALLOW"'"]},"'"$$CODER_DOMAIN"'":{"username":"'"$$CODER_USER"'","password":"'"$$CODER_ACME_DNS_PASSWORD"'","fulldomain":"'"$$CODER_ACME_DNS_FULLDOMAIN"'","subdomain":"'"$$CODER_ACME_DNS_SUBDOMAIN"'","allowfrom":["'"$$CODER_ALLOW"'"]}}' | \
	kubectl create secret generic acme-dns \
		--namespace cert-manager \
		--from-file=acmedns.json=/dev/stdin \
		--dry-run=client -o yaml | kubectl apply -f -

hermes-secrets:
	kubectl get namespace hermes >/dev/null 2>&1 || kubectl create namespace hermes
	$(LOAD_ENV) || true; \
	kubectl create secret generic hermes-agent-secrets \
		--namespace hermes \
		--from-literal=HERMES_DASHBOARD_OIDC_CLIENT_SECRET="$$HERMES_DASHBOARD_OIDC_CLIENT_SECRET" \
		--from-literal=API_SERVER_KEY="$$HERMES_API_SERVER_KEY" \
		--dry-run=client -o yaml | kubectl apply -f -

openclaw-secrets:
	kubectl get namespace openclaw >/dev/null 2>&1 || kubectl create namespace openclaw
	$(LOAD_ENV) || true; \
	kubectl create secret generic openclaw-secrets \
		--namespace openclaw \
		--from-literal=OPENCLAW_GATEWAY_TOKEN="$$OPENCLAW_GATEWAY_TOKEN" \
		--dry-run=client -o yaml | kubectl apply -f -

omniroute-secrets:
	$(LOAD_ENV) || true; \
	OMNIROUTE_NS=$${OMNIROUTE_NAMESPACE:-omniroute} && \
	kubectl get namespace $$OMNIROUTE_NS >/dev/null 2>&1 || kubectl create namespace $$OMNIROUTE_NS && \
	kubectl create secret generic omniroute-secrets \
		--namespace $$OMNIROUTE_NS \
		--from-literal=OMNIROUTE_LOCAL_ENDPOINTS_TOKEN="$$OMNIROUTE_LOCAL_ENDPOINTS_TOKEN" \
		--from-literal=OPENAI_API_KEY="$$OPENAI_API_KEY" \
		--from-literal=ANTHROPIC_API_KEY="$$ANTHROPIC_API_KEY" \
		--from-literal=GEMINI_API_KEY="$$GEMINI_API_KEY" \
		--from-literal=DEEPSEEK_API_KEY="$$DEEPSEEK_API_KEY" \
		--dry-run=client -o yaml | kubectl apply -f -

init-shared-db:
	chmod +x scripts/init-shared-db.py && ENV_FILE=$(ENV_FILE) ./scripts/init-shared-db.py

# Create/update the basic-auth .htpasswd secret used by the Envoy Gateway
# HTTPS CONNECT forward proxy (SecurityPolicy.basicAuth in the gw chart).
proxy-secrets:
	kubectl get namespace gw >/dev/null 2>&1 || kubectl create namespace gw
	$(LOAD_ENV) || true; \
	PROXY_USER=$${PROXY_USERNAME:-proxy} && \
	PROXY_SHA=$$(printf '%s' "$${PROXY_PASSWORD:-changeme}" | openssl dgst -sha1 -binary | base64) && \
	printf '%s:{SHA}%s\n' "$$PROXY_USER" "$$PROXY_SHA" | \
	kubectl create secret generic proxy-auth \
		--namespace gw \
		--from-file=.htpasswd=/dev/stdin \
		--dry-run=client -o yaml | kubectl apply -f -

helm-apply: acme-dns-secret hermes-secrets openclaw-secrets omniroute-secrets proxy-secrets init-shared-db repos
	$(HELMFILE) sync

# Requires helm-diff: helm plugin install https://github.com/databus23/helm-diff
helm-diff: repos
	$(HELMFILE) diff --args "--disable-validation"

destroy:
	$(HELMFILE) destroy

# Reconcile the single ingress NLB backends after node pool scaling changes.
# The pulumi NLB uses a static backend list (filtered to ACTIVE nodes at plan
# time), so run this after adding/removing worker nodes.
PULUMI_STACK ?= dev
nlb-sync:
	pulumi -C pulumi/oke up --stack $(PULUMI_STACK) --yes

inspect-node-scale-log:
	kubectl logs -n kube-system -l "app.kubernetes.io/name=oci-cluster-autoscaler,app.kubernetes.io/instance=cluster-autoscaler" --tail=100 -f
