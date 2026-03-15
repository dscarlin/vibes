locals {
  worker_snapshot_bucket_name = trimspace(var.workspace_snapshot_bucket_name) != ""
    ? trimspace(var.workspace_snapshot_bucket_name)
    : "vibes-workspace-snapshots-${data.aws_caller_identity.current.account_id}-${var.region}"
}

resource "aws_iam_policy" "worker_irsa" {
  name = "${var.cluster_name}-worker-irsa-policy"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:DescribeRepositories",
          "ecr:CreateRepository"
        ],
        Resource = "*"
      },
      {
        Effect = "Allow",
        Action = [
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:ListBucketMultipartUploads"
        ],
        Resource = "arn:aws:s3:::${local.worker_snapshot_bucket_name}",
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "project-workspaces/*",
              "project-workspaces"
            ]
          }
        }
      },
      {
        Effect = "Allow",
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts"
        ],
        Resource = "arn:aws:s3:::${local.worker_snapshot_bucket_name}/project-workspaces/*"
      }
    ]
  })
}

module "worker_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.39.1"

  role_name = "${var.cluster_name}-worker-irsa"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["vibes-platform:worker-sa"]
    }
  }

  role_policy_arns = {
    worker = aws_iam_policy.worker_irsa.arn
  }
}

output "worker_irsa_role_arn" {
  value = module.worker_irsa.iam_role_arn
}
