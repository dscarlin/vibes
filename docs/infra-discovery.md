# AWS Test Replica Discovery

## Environment Snapshot
- AWS account: `897297231794`
- Primary region: `us-east-1`
- Live EKS cluster: `vibes-platform`
- Live Route53 hosted zone: `vibesplatform.ai` (`Z0006210KPHCW9YQJJ6X`)
- Live ACM cert: `arn:aws:acm:us-east-1:897297231794:certificate/e719aa33-62f3-4e86-bc38-50c5f2251aa3`

## What The Current Platform Actually Uses

### Platform workloads
- Namespace `vibes-platform`
  - `vibes-server`
  - `vibes-web`
  - `vibes-worker`
  - `redis`
- Namespace `vibes-development`
  - Per-project customer app deployments and services
  - Per-project workspace pods, services, and PVCs
  - Per-project ALB ingresses

### AWS foundations
- VPC: `vpc-0356c6e0d2e92ce90`
- EKS nodegroups in live cluster
  - `platform-core`
  - `customer-core`
  - `customer-apps` exists but is scaled to zero
- RDS PostgreSQL 16 instance: `vibes-dev-db`
- ECR repositories
  - `vibes-server`
  - `vibes-web`
  - `vibes-worker`
  - `vibes-app`
- S3 buckets
  - `vibes-workspace-snapshots-897297231794-us-east-1`
  - `vibes-alb-logs-897297231794-us-east-1`
- Shared ALB
  - `k8s-vibesshared-70ce795ad7`

### Cluster add-ons and controllers
- EKS add-ons
  - `vpc-cni`
  - `coredns`
  - `kube-proxy`
  - `metrics-server`
  - `aws-ebs-csi-driver`
- Helm-managed AWS Load Balancer Controller
- Ingress class `alb`
- Storage currently bound through `gp2`

## Application Requirements Derived From Code

### Server
- Requires platform PostgreSQL database via `DATABASE_URL`
- Requires Redis for BullMQ queue publishing
- Requires JWT secret
- Runs database migrations on startup when `RUN_MIGRATIONS=true`
- Exposes the validation surfaces:
  - `/auth/register`
  - `/projects`
  - `/projects/:id/tasks`
  - `/projects/:id/repo-download`
  - `/projects/:id/development/wake`
  - `/projects/:id/runtime-logs`

### Worker
- Requires platform PostgreSQL database
- Requires admin access to the customer database host for per-project DB creation
- Requires Redis for BullMQ queue consumption
- Requires ECR push access for customer app images
- Requires Route53 write access for dynamic preview host records
- Requires ELB describe access for ALB alias targets
- Requires S3 read/write for workspace snapshots
- Requires S3 read access for ALB access log ingestion
- Creates and destroys:
  - per-project app deployments
  - services
  - ingresses
  - env secrets
  - workspace PVCs and pods

### Web
- Requires only `API_URL`, `DOMAIN`, and optional upgrade link

## Database Findings
- Platform database schema is fully migration-driven.
- Current platform tables in use:
  - `users`, `projects`, `environments`, `tasks`, `sessions`, `builds`
  - `project_workspaces`, `runtime_usage`, `bandwidth_usage`, `bandwidth_log_ingest`
  - `settings`, `admin_alerts`, `admin_audit_log`
- Live platform database counts at discovery time:
  - users: 3
  - projects: 8
  - environments: 24
  - tasks: 90
  - sessions: 2
  - builds: 133
  - project workspaces: 4
- Customer databases are created per project and environment using the pattern:
  - `vibes_<shortid>_development`
  - `vibes_<shortid>_testing`
  - `vibes_<shortid>_production`
- Customer database roles in use:
  - `vibes_admin`
  - `vibes_platform`

## DNS and TLS Findings
- Live public records point at the shared ALB.
- Dynamic project preview records are written directly into Route53 by the worker.
- The wildcard certificate covers:
  - `vibesplatform.ai`
  - `*.vibesplatform.ai`
- Several stale records still point at old ALBs and should not be copied into the replica.

## IAM Findings
- Worker IRSA role in live uses:
  - ECR push access for the customer app repository
  - S3 read/write for workspace snapshot objects
  - S3 read for ALB access logs
  - Route53 change access on the hosted zone
  - ELB describe access for alias target resolution
- AWS Load Balancer Controller uses a dedicated IRSA role.
- EBS CSI uses a dedicated IRSA role with `AmazonEBSCSIDriverPolicy`.

## Secrets Classification

### Infrastructure-managed
- Replica RDS master credentials
- Replica platform DB user password
- Replica customer DB admin password
- Replica ACM certificate validation records

### App runtime secrets or overrides
- `/vibes/test-replica/server`
- `/vibes/test-replica/web`
- `/vibes/test-replica/worker`

### Sensitive manual injection points
- OpenAI API key
- Git token for starter repo access if private or rate-limited
- JWT secret override if a fixed value is required
- Optional alerting webhooks

## Drift To Preserve As Documentation Only
- `infra/terraform/eks` is a draft scaffold and not the current live source of truth.
- `cert-manager`, `ingress-nginx`, `cluster-issuer`, and `route53-credentials-secret` exist in repo but are not active in the live cluster.
- `vibes-system` exists in repo but is not used by the live runtime path.
- `web-env` secret exists live but is unused by the current deployments.
- `vibes-server` and `vibes-web` are currently exposed through both `LoadBalancer` Services and ALB ingresses; the replica will keep only the ingress path.

## Replica Defaults Chosen
- Replica domain: `replica.vibesplatform.ai`
- Fresh isolated RDS database, no data restore
- Secrets Manager for runtime overrides
- Dedicated replica ECR repositories and S3 buckets
- One platform nodegroup and one tainted customer nodegroup
- `gp3` storage class instead of carrying forward live `gp2`
