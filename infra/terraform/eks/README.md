# EKS Terraform Scaffold

> [!WARNING]
> This directory is **not** the authoritative source of truth for the current production AWS infrastructure.
> Do **not** run `terraform apply`, `terraform destroy`, or `terraform import` against the live Vibes environment from this folder.
> The files here are a draft scaffold/reference and have known drift from production.
> Use this folder only for controlled future infrastructure codification work in a separate non-production environment.

This is a minimal EKS + VPC + ECR scaffold for Vibes.

See [WARNING.md](./WARNING.md) before using anything in this directory.

## Usage

The commands below are shown for future isolated testing only. They are **not approved for the current live environment**.

```
cd infra/terraform/eks
terraform init
terraform apply
```

Then update kubeconfig:
```
aws eks update-kubeconfig --name vibes-eks --region us-east-1
```

## Outputs
- `cluster_name`
- `cluster_endpoint`
- `cluster_region`
- `ecr_repository_url`
- `worker_role_arn`
- `worker_irsa_role_arn`

## Notes
- Current status: draft scaffold, not production-safe
- Creates a VPC with public + private subnets
- Creates an EKS cluster and one managed node group
- Creates an ECR repo for customer app images
- Creates IAM role + policy for the worker to push to ECR
- Creates IRSA role for `vibes-platform/worker-sa`
- Grants the worker scoped access to the workspace snapshot bucket prefix `project-workspaces/*`
- Apply `infra/k8s/worker-service-account.yaml` and replace the role ARN
- Adjust `variables.tf` for sizing
