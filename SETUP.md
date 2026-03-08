# Vibes Platform Setup

This document tracks everything needed to run Vibes in **development** and **production**.

## 1) Prerequisites

### Local Dev
- Node.js 20+
- Podman + podman-compose
- PostgreSQL (for platform DB)
- Redis (for queue)

### Production
- AWS account
- EKS cluster
- `kubectl`, `aws`, `helm` installed and configured
- ECR repository access
- Route53 hosted zone for your domain

## 2) Environment Variables

Copy `.env.example` to `.env` and fill in values.

**Core**
- `PORT`
- `WEB_PORT`
- `DATABASE_URL` (platform DB)
- `RUN_MIGRATIONS`
- `JWT_SECRET`
- `DOMAIN`
- `CORS_ORIGIN`

**OpenAI**
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

**Redis**
- `REDIS_HOST`
- `REDIS_PORT`

**Starter Repo**
- `STARTER_REPO_URL`
- `STARTER_REPO_REF`
- `GIT_TOKEN`

**Customer DB Cluster** (separate from platform DB)
- `CUSTOMER_DB_ADMIN_URL`
- `CUSTOMER_DB_HOST`
- `CUSTOMER_DB_PORT`
- `CUSTOMER_DB_USER`
- `CUSTOMER_DB_PASSWORD`
- `CUSTOMER_DB_SSLMODE`

**Deploy Commands**
- `DEV_DEPLOY_COMMAND`
- `TEST_DEPLOY_COMMAND`
- `PROD_DEPLOY_COMMAND`

**AWS / ECR**
- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `ECR_REPO`

## 3) Development Setup

### Platform DB
- Create a local Postgres DB for platform metadata.
- Ensure `DATABASE_URL` points to it.

### Redis
- Run Redis locally on `REDIS_HOST` / `REDIS_PORT`.

### Codex CLI (dev)
- Install Codex CLI for task execution:
  - `npm install -D @openai/codex`
- Ensure the worker runs on Node.js 20 to avoid compatibility issues.

### Start services
- `node server/src/index.js`
- `node worker/src/index.js`
- `node web/src/index.js`

### Dev app deployment (podman)
- Use `infra/dev/podman-compose.yml` for local dev DB + nginx only.
- The dev deploy command is `./infra/dev/deploy.sh`.

## 4) Production Setup (EKS + ECR)

### 4.1 ECR
- Ensure the repo exists:
  - Name: `ECR_REPO`
- The deploy script auto-creates if missing.

### 4.2 Namespaces
Create namespaces for environments:
- `vibes-development`
- `vibes-testing`
- `vibes-production`

### 4.3 Ingress Controller
Apply nginx ingress:
- `kubectl apply -f infra/k8s/ingress-controller.yaml`

### 4.4 Cert-Manager + DNS01
Run:
- `./infra/k8s/apply-cert-resources.sh`

Update these files before applying:
- `infra/k8s/cluster-issuer-dns01.yaml`
- `infra/k8s/route53-credentials-secret.yaml`
- `infra/k8s/wildcard-certificate.yaml`

### 4.5 Wildcard DNS
Point `*.yourdomain.com` to the NLB created by nginx ingress.

### 4.6 Postgres for Customer Apps
Apply Postgres base for each env namespace:
- `kubectl -n vibes-testing apply -f infra/k8s/base/postgres.yaml`
- `kubectl -n vibes-production apply -f infra/k8s/base/postgres.yaml`

## 5) Empty Database

Empty DB uses per-project DBs inside the **customer DB cluster**.
Triggered via API:
- `POST /projects/:projectId/env/:environment/empty-db`

## 6) Deploy Flow

When a task completes:
- Worker builds image, pushes to ECR
- Applies deployment + service + ingress
- Injects `DATABASE_URL` and env vars via secret

## 7) Required IAM Permissions
The worker must have:
- ECR push/pull
- EKS kubectl access
- Route53 DNS update for DNS01 (if using cert-manager)

## 8) Known Placeholders to Update
- `admin@yourdomain.com` in issuers
- `yourdomain.com` in wildcard cert
- Route53 hosted zone ID
- AWS credentials for DNS01 secret
