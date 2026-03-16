.PHONY: setup dev certs stop logs worker-kustomize aws-dev-up aws-dev-down server-apply web-apply build-push deploy-all desktop-release status-check db-tunnel stop-db-tunnel replica-plan replica-up replica-destroy-plan replica-down replica-validate replica-seed-secrets-plan replica-seed-secrets agent-task agent-task-cleanup

AWS_REGION ?= us-east-1
RDS_CA_FILE ?= ./rds-ca.pem
SERVER_ENV_FILE ?= ./.env.server
WEB_ENV_FILE ?= ./.env.web
WORKER_ENV_FILE ?= ./.env.worker
K8S_APPLY_ENV_FILE ?= ./.env.k8s.apply
API_URL ?= https://api.vibesplatform.ai
DOMAIN ?= vibesplatform.ai
DB_TUNNEL_LOCAL_PORT ?= 15432
DB_TUNNEL_REMOTE_HOST ?=
DB_TUNNEL_REMOTE_PORT ?=
DB_TUNNEL_TARGET ?=
DB_TUNNEL_DRY_RUN ?= false

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

db-tunnel:
	AWS_REGION=$(AWS_REGION) \
	SERVER_ENV_FILE=$(SERVER_ENV_FILE) \
	DB_TUNNEL_LOCAL_PORT=$(DB_TUNNEL_LOCAL_PORT) \
	DB_TUNNEL_REMOTE_HOST=$(DB_TUNNEL_REMOTE_HOST) \
	DB_TUNNEL_REMOTE_PORT=$(DB_TUNNEL_REMOTE_PORT) \
	DB_TUNNEL_TARGET=$(DB_TUNNEL_TARGET) \
	DB_TUNNEL_DRY_RUN=$(DB_TUNNEL_DRY_RUN) \
	./scripts/aws/db-tunnel.sh

stop-db-tunnel:
	@pids=$$(pgrep -f "aws ssm start-session.*AWS-StartPortForwardingSessionToRemoteHost.*$(DB_TUNNEL_LOCAL_PORT)" || true); \
	if [ -n "$$pids" ]; then \
		echo "Stopping DB tunnel on local port $(DB_TUNNEL_LOCAL_PORT): $$pids"; \
		kill $$pids; \
	else \
		echo "No DB tunnel found on local port $(DB_TUNNEL_LOCAL_PORT)."; \
	fi

replica-plan:
	./scripts/replica/up.sh plan

replica-up:
	./scripts/replica/up.sh apply

replica-destroy-plan:
	./scripts/replica/down.sh plan

replica-down:
	./scripts/replica/down.sh apply

replica-validate:
	node ./validation/run-replica-flow.mjs

replica-seed-secrets-plan:
	node ./scripts/replica/seed-secrets.mjs plan

replica-seed-secrets:
	node ./scripts/replica/seed-secrets.mjs apply

agent-task:
	node ./scripts/agent-task/index.mjs run $(ARGS)

agent-task-cleanup:
	node ./scripts/agent-task/index.mjs cleanup $(ARGS)
