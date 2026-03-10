.PHONY: setup dev certs stop logs worker-kustomize aws-dev-up aws-dev-down server-apply web-apply build-push deploy-all desktop-release status-check

AWS_REGION ?= us-east-1
RDS_CA_FILE ?= ./rds-ca.pem
SERVER_ENV_FILE ?= ./.env.server
WEB_ENV_FILE ?= ./.env.web
WORKER_ENV_FILE ?= ./.env.worker
K8S_APPLY_ENV_FILE ?= ./.env.k8s.apply
API_URL ?= https://api.vibesplatform.ai
DOMAIN ?= vibesplatform.ai

setup:
	./scripts/bootstrap.sh

dev:
	./scripts/bootstrap.sh

certs:
	./infra/k8s/apply-cert-resources.sh

stop:
	./scripts/stop.sh

logs:
	./scripts/logs.sh

status-check:
	sh ./scripts/status-check.sh

worker-kustomize:
	./scripts/kustomize-worker-from-env.sh
	KUSTOMIZATION_FILE=infra/k8s/worker-kustomization/kustomization.generated.yaml \
		kubectl kustomize -f "$$KUSTOMIZATION_FILE" | kubectl apply -f -

aws-dev-up:
	./scripts/aws/eks-dev-up.sh

aws-dev-down:
	./scripts/aws/eks-dev-down.sh

server-apply:
	./infra/k8s/server-apply.sh

web-apply:
	./infra/k8s/web-apply.sh

build-push:
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; ./scripts/aws/build-push.sh

deploy-all: build-push
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; AWS_REGION=$(AWS_REGION) RDS_CA_FILE=$(RDS_CA_FILE) ./infra/k8s/rds-ca-secret-apply.sh
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; AWS_REGION=$(AWS_REGION) SERVER_ENV_FILE=$(SERVER_ENV_FILE) ./infra/k8s/server-secret-apply.sh
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; AWS_REGION=$(AWS_REGION) WEB_ENV_FILE=$(WEB_ENV_FILE) ./infra/k8s/web-secret-apply.sh
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; AWS_REGION=$(AWS_REGION) WORKER_ENV_FILE=$(WORKER_ENV_FILE) ./infra/k8s/worker-secret-apply.sh
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; kubectl -n vibes-platform rollout restart deploy/vibes-server deploy/vibes-web deploy/vibes-worker
	set -a; . $(K8S_APPLY_ENV_FILE); set +a; kubectl -n vibes-platform rollout status deploy/vibes-server deploy/vibes-web deploy/vibes-worker

desktop-release:
	@echo "Building desktop release..."
	@cd desktop && API_URL=$(API_URL) DOMAIN=$(DOMAIN) NOTARIZE_MACOS=$(NOTARIZE_MACOS) WINDOWS_SIGN=$(WINDOWS_SIGN) WINDOWS_SIGN_TARGET=$(WINDOWS_SIGN_TARGET) ./scripts/build-release.sh
