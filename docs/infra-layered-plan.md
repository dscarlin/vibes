# AWS Test Replica Layered Plan

## Layer 1: Cloud Foundation

### Scope
- Remote Terraform state bucket and lock table
- Replica VPC and subnets
- Replica EKS cluster and nodegroups
- Replica RDS PostgreSQL instance
- Replica ECR repositories
- Replica workspace snapshot bucket
- Replica ALB access log bucket
- Replica ACM certificate and validation records
- Replica IAM and IRSA roles

### Inputs
- AWS account and region
- Hosted zone name
- Replica subdomain
- Sizing variables for nodes and RDS

### Outputs
- VPC and subnet IDs
- EKS cluster name, endpoint, CA data, OIDC provider
- Node security groups
- RDS endpoint and generated infra secret ARN
- ACM certificate ARN
- ECR repository URLs and names
- S3 bucket names
- Route53 zone ID
- Worker, ALB controller, and EBS CSI IRSA role ARNs

### Management boundary
- Terraform-managed

## Layer 2: Cluster Platform

### Scope
- EKS add-ons
- AWS Load Balancer Controller Helm install
- Namespaces
- Replica `gp3` storage class

### Inputs
- Layer 1 outputs
- Helm chart version and replica naming values

### Outputs
- Ready Kubernetes control plane
- Ingress class `alb`
- Replica namespaces and storage class

### Management boundary
- Terraform-managed:
  - `aws_eks_addon`
  - Helm release
  - Kubernetes namespaces and storage class

## Layer 3: Application Deployables

### Scope
- Redis deployment and service
- Server, web, and worker deployments
- Server and web ClusterIP services
- Shared ALB ingresses for server and web
- RBAC and service accounts for server and worker
- Runtime secrets sync from Secrets Manager
- Database initialization for `vibes_platform`, `vibes_platform` role, and `vibes_admin` role
- Base Route53 alias records for:
  - `replica.vibesplatform.ai`
  - `app.replica.vibesplatform.ai`
  - `api.replica.vibesplatform.ai`
- Dynamic project runtime remains worker-managed

### Inputs
- Layer 1 outputs
- Manual Secrets Manager secret values
- Current repo Dockerfiles and manifests

### Outputs
- Healthy platform API, web UI, worker, and Redis
- Public replica URLs
- Validation evidence artifacts

### Management boundary
- Script and Kubernetes-managed

## Secrets Contract

### `/vibes/test-replica/server`
- Required
  - `JWT_SECRET`
  - `OPENAI_API_KEY`
- Optional overrides
  - `OPENAI_MODEL`
  - `ALLOW_PASSWORD_BYPASS`
  - `MAX_UPLOAD_MB`
  - `DEFAULT_USER_PLAN`
  - `ADMIN_API_KEY`
  - `DESKTOP_DOWNLOAD_DIR`
  - `RUNTIME_QUOTAS`
  - `PLAN_LIMITS`
  - `NODEGROUP_MONTHLY_COSTS`

### `/vibes/test-replica/web`
- Optional overrides
  - `UPGRADE_URL`

### `/vibes/test-replica/worker`
- Required
  - `OPENAI_API_KEY`
  - `GIT_TOKEN`
- Optional overrides
  - `OPENAI_MODEL`
  - `STARTER_REPO_URL`
  - `STARTER_REPO_REF`
  - healthcheck overrides
  - runtime and quota overrides
  - alert webhook overrides

## Validation Flow
1. Register a new user against the replica API.
2. Create a project and wait for starter snapshot readiness.
3. Submit a deterministic prompt with a unique marker.
4. Wait for task completion and a stable development state.
5. Wake development preview for the completed task commit.
6. Verify the preview URL serves the marker.
7. Download the repo bundle and verify the marker in source.
8. Save evidence files, logs, URLs, and identifiers under `validation/evidence/<timestamp>`.

## Destroy Flow
1. Print Terraform destroy plans for Layer 2 and Layer 1.
2. Print replica-specific Route53 records, ECR repositories, and S3 object counts.
3. Delete Layer 3 workloads and replica DNS records.
4. Destroy Layer 2.
5. Destroy Layer 1.
6. Leave remote-state bootstrap resources intact by design.
