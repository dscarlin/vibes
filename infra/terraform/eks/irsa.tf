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
      namespace_service_accounts = ["vibes-system:worker-sa"]
    }
  }

  role_policy_arns = {
    worker = aws_iam_policy.worker_irsa.arn
  }
}

output "worker_irsa_role_arn" {
  value = module.worker_irsa.iam_role_arn
}
