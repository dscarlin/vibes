# EKS Terraform Scaffold

This is a minimal EKS + VPC + ECR scaffold for Vibes.

## Usage

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
- Creates a VPC with public + private subnets
- Creates an EKS cluster and one managed node group
- Creates an ECR repo for customer app images
- Creates IAM role + policy for the worker to push to ECR
- Creates IRSA role for `vibes-platform/worker-sa`
- Apply `infra/k8s/worker-service-account.yaml` and replace the role ARN
- Adjust `variables.tf` for sizing
