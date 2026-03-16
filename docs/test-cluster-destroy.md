# Test Replica Destroy Runbook

## Dry run
```sh
make replica-destroy-plan
```

The dry run prints:
- Layer 2 destroy plan
- Layer 1 destroy plan
- Replica Route53 records targeted for deletion
- Replica ECR repositories targeted by naming convention
- Replica S3 buckets targeted by naming convention
- Bootstrap Terraform state bucket object/version counts
- Bootstrap DynamoDB lock table target

## Destroy
```sh
make replica-down
```

This workflow performs:
1. Delete Layer 3 workloads and replica-only DNS records
2. Destroy Layer 2
3. Destroy Layer 1
4. Delete the bootstrap remote-state bucket and lock table
5. Clear local Terraform working directories for bootstrap, Layer 1, and Layer 2

Destroy ordering is strict:
- Layer 1 destroy does not run if Layer 2 destroy fails.
- This prevents orphaned replica ALBs, ENIs, and security groups from blocking the VPC teardown.

## Safety Guarantees
- Only records under `replica.vibesplatform.ai` are targeted.
- Only Terraform resources tagged `vibes:env=test-replica` are planned for destroy.
- Only dedicated replica ECR repositories and replica S3 buckets are targeted.
- Only the deterministic replica bootstrap bucket and lock table are targeted.
- No commands point at the live `vibes-platform` cluster or live apex hosts.

## Post-destroy Verification
- `aws eks list-clusters --region us-east-1`
- `aws rds describe-db-instances --region us-east-1`
- `aws ecr describe-repositories --region us-east-1`
- `aws route53 list-resource-record-sets --hosted-zone-id Z0006210KPHCW9YQJJ6X`

Expected result:
- No replica EKS cluster remains
- No replica RDS instance remains
- No replica ECR repositories remain
- No `replica.vibesplatform.ai` records remain
- No replica snapshot or ALB log buckets remain
- No replica remote-state bucket remains
- No replica lock table remains
