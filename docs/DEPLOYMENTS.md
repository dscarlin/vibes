# Deployments (Dev + AWS)

This repo supports two modes:

- **Local dev**: `podman-compose` + local Node processes.
- **AWS/EKS**: Terraform/EKS + Docker images in ECR + Kubernetes manifests.

Below is a coherent, idempotent path for each.

---

## Local Dev (idempotent)

Start:
```bash
make dev
```

Stop:
```bash
make stop
```

Logs:
```bash
make logs
```

Notes:
- `scripts/bootstrap.sh` starts db + nginx via `infra/dev/podman-compose.yml`, then runs server/worker/web locally.
- Nginx config is copied and reloaded on each `make dev`.

---

## AWS/EKS Overview

**Core pieces:**
- EKS cluster + ECR (Terraform or `eksctl`)
- RDS (single instance for platform + customer DBs)
- Worker deployment (required for tasks + deploys)
- Server + Web deployments
- Secrets for each component

Namespace: `vibes-platform`

---

## Build & Push Images (Manual)

Assume ECR repos:
- `vibes-web`
- `vibes-server`
- `vibes-worker`

Login:
```bash
AWS_REGION=us-east-1
ACCOUNT_ID=YOUR_ACCOUNT_ID
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
```

Build + push **server**:
```bash
docker build -t vibes-server -f server/Dockerfile .
docker tag vibes-server:latest ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-server:latest
docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-server:latest
```

Build + push **web**:
```bash
docker build -t vibes-web -f web/Dockerfile .
docker tag vibes-web:latest ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-web:latest
docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-web:latest
```

Build + push **worker**:
```bash
docker build -t vibes-worker -f worker/Dockerfile .
docker tag vibes-worker:latest ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-worker:latest
docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-worker:latest
```

Or use the helper (builds linux/amd64, auto-tags with git SHA, and also pushes `latest` by default):
```bash
ACCOUNT_ID=YOUR_ACCOUNT_ID AWS_REGION=us-east-1 make build-push
```

Override tag:
```bash
ACCOUNT_ID=YOUR_ACCOUNT_ID AWS_REGION=us-east-1 TAG=v1.2.3 make build-push
```

---

## Apply Secrets (idempotent)

Create local env files (do not commit):
- `./.env.worker` (see `.env.worker.example`)
- `./.env.server` (see `.env.server.example`)
- `./.env.web` (see `.env.web.example`)

Apply RDS CA bundle (required for TLS to RDS):
```bash
RDS_CA_FILE=./rds-ca.pem ./infra/k8s/rds-ca-secret-apply.sh
```

Download the AWS RDS CA bundle from AWS and save it as `rds-ca.pem` before running.

Apply secrets:
```bash
WORKER_ENV_FILE=./.env.worker ./infra/k8s/worker-secret-apply.sh
SERVER_ENV_FILE=./.env.server ./infra/k8s/server-secret-apply.sh
WEB_ENV_FILE=./.env.web ./infra/k8s/web-secret-apply.sh
```

---

## Deploy Worker / Server / Web (idempotent)

Worker:
```bash
WORKER_IMAGE=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-worker:latest \
  ./infra/k8s/worker-apply.sh
```

Server:
```bash
SERVER_IMAGE=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-server:latest \
  ./infra/k8s/server-apply.sh
```

Web:
```bash
WEB_IMAGE=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/vibes-web:latest \
  ./infra/k8s/web-apply.sh
```

---

## Get Public URLs (ELB hostnames)

```bash
kubectl -n vibes-platform get svc vibes-web vibes-server
```

Each service will show an `EXTERNAL-IP` hostname from AWS.

If you are using ALB Ingress, the public URLs come from the Ingress instead:

```bash
kubectl -n vibes-platform get ingress
```

Use the `ADDRESS` value for DNS (CNAME/ALIAS) to your domain.

---

## Notes on Customer App Deploys

The worker uses `infra/k8s/deploy.sh` to:
- Build a Docker image from project snapshots
- Push to ECR (`ECR_REPO`)
- Apply app + ingress manifests

Resource limits for customer apps are enforced by `deploy.sh` with per-environment defaults:
- development: 100m/256Mi requests, 500m/512Mi limits
- testing: 200m/512Mi requests, 1 CPU/1Gi limits
- production: 300m/512Mi requests, 1500m/2Gi limits

You can override via env:
- `APP_CPU_REQUEST`, `APP_CPU_LIMIT`, `APP_MEM_REQUEST`, `APP_MEM_LIMIT`
- or `DEV_*`, `TEST_*`, `PROD_*` variants (e.g. `DEV_CPU_REQUEST`)

To schedule customer apps onto a dedicated nodegroup, set:
- `CUSTOMER_NODEGROUP_ENABLED=true`
- `CUSTOMER_NODEGROUP_LABEL=nodegroup`
- `CUSTOMER_NODEGROUP_VALUE=customer`
- `CUSTOMER_NODEGROUP_TAINT_KEY=nodegroup`
- `CUSTOMER_NODEGROUP_TAINT_VALUE=customer`

`deploy.sh` will apply `nodeSelector` + `tolerations` when enabled. Development workspace pods created by the worker also honor these same `CUSTOMER_NODEGROUP_*` settings, with a best-effort fallback to normal scheduling if no matching customer nodes are available. Legacy workspace PVCs that are already pinned to a different availability zone will also fall back until the workspace volume is recreated in a customer-node zone.

If you are using ALB, ensure the ingress manifests use `spec.ingressClassName: alb`
and that the AWS Load Balancer Controller is installed.

## Install AWS Load Balancer Controller (ALB)

Prereqs:
- `eksctl`, `helm`, `aws` CLI installed
- Cluster name, region, VPC ID

```bash
eksctl utils associate-iam-oidc-provider \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER_NAME" \
  --approve

curl -o /tmp/aws-lb-iam-policy.json \
  https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file:///tmp/aws-lb-iam-policy.json

eksctl create iamserviceaccount \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy" \
  --approve \
  --region "$AWS_REGION"

helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm upgrade -i aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName="$CLUSTER_NAME" \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region="$AWS_REGION" \
  --set vpcId="$VPC_ID"
```

Ensure worker secret includes:
- `AWS_REGION`, `AWS_ACCOUNT_ID`, `ECR_REPO`, `DOMAIN`
- DB + Redis + Git + socket settings
- `DEV_DEPLOY_COMMAND`, `TEST_DEPLOY_COMMAND`, `PROD_DEPLOY_COMMAND` should be `/app/infra/k8s/deploy.sh`
- `HEALTHCHECK_PATH` (default `/`) and optional `HEALTHCHECK_PATH_DEV/TEST/PROD`

---

## Terraform vs eksctl

- `infra/terraform/eks` is the preferred scaffold for production.
- `scripts/aws/eks-dev-up.sh` / `eks-dev-down.sh` are for quick dev clusters.

---

## Cleanup (idempotent)

Delete cluster (dev):
```bash
make aws-dev-down
```

Delete deployed apps:
```bash
kubectl -n vibes-platform delete deploy vibes-worker vibes-server vibes-web --ignore-not-found
kubectl -n vibes-platform delete svc vibes-server vibes-web --ignore-not-found
```
