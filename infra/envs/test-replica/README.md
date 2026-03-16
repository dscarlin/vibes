# Test Replica Environment

This directory contains the Terraform roots for the isolated AWS test replica:

- `layer1/`: cloud foundation resources such as VPC, EKS, IAM/IRSA, RDS, ECR, S3, ACM, and Secrets Manager contracts
- `layer2/`: cluster-platform resources such as EKS add-ons, the AWS Load Balancer Controller, namespaces, and the `gp3` storage class

The paired orchestration entrypoints live under `scripts/replica/`:

- `scripts/replica/up.sh plan|apply`
- `scripts/replica/down.sh plan|apply`

`infra/bootstrap/remote-state/` bootstraps the S3 bucket and DynamoDB lock table used by the layer states.
