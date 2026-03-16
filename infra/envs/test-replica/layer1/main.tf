data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_route53_zone" "primary" {
  name         = var.root_domain
  private_zone = false
}

locals {
  account_id              = data.aws_caller_identity.current.account_id
  cluster_name            = trimspace(var.cluster_name) != "" ? trimspace(var.cluster_name) : var.name_prefix
  selected_azs            = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  replica_domain          = "${var.replica_subdomain}.${var.root_domain}"
  root_host               = local.replica_domain
  api_host                = "api.${local.replica_domain}"
  app_host                = "app.${local.replica_domain}"
  alb_group_name          = "${var.name_prefix}-shared"
  platform_nodegroup_name = "${var.name_prefix}-platform-core"
  customer_nodegroup_name = "${var.name_prefix}-customer-core"

  workspace_snapshot_bucket_name = "${var.name_prefix}-workspace-snapshots-${local.account_id}-${var.aws_region}"
  alb_log_bucket_name            = "${var.name_prefix}-alb-logs-${local.account_id}-${var.aws_region}"
  server_repository_name         = "${var.name_prefix}-server"
  web_repository_name            = "${var.name_prefix}-web"
  worker_repository_name         = "${var.name_prefix}-worker"
  customer_app_repository_name   = "${var.name_prefix}-app"

  common_tags = merge(
    {
      "vibes:env"  = "test-replica"
      "managed-by" = "terraform"
      "layer"      = "cloud-foundation"
    },
    var.tags
  )
}

module "networking" {
  source = "../../../modules/networking"

  availability_zones   = local.selected_azs
  cluster_name         = local.cluster_name
  name_prefix          = var.name_prefix
  private_subnet_cidrs = var.private_subnet_cidrs
  public_subnet_cidrs  = var.public_subnet_cidrs
  tags                 = local.common_tags
  vpc_cidr             = var.vpc_cidr
}

module "eks" {
  source = "../../../modules/eks-cluster"

  cluster_name                 = local.cluster_name
  cluster_version              = var.cluster_version
  customer_node_desired_size   = var.customer_node_desired_size
  customer_node_instance_types = [var.customer_node_instance_type]
  customer_node_max_size       = var.customer_node_max_size
  customer_node_min_size       = var.customer_node_min_size
  customer_nodegroup_name      = local.customer_nodegroup_name
  node_disk_size               = var.node_disk_size
  platform_node_desired_size   = var.platform_node_desired_size
  platform_node_instance_types = [var.platform_node_instance_type]
  platform_node_max_size       = var.platform_node_max_size
  platform_node_min_size       = var.platform_node_min_size
  platform_nodegroup_name      = local.platform_nodegroup_name
  subnet_ids                   = module.networking.private_subnet_ids
  tags                         = local.common_tags
}

resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "platform_db" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "customer_db_admin" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_security_group" "replica_db" {
  name        = "${var.name_prefix}-db"
  description = "Replica PostgreSQL access from workloads inside the replica VPC"
  vpc_id      = module.networking.vpc_id

  ingress {
    description = "PostgreSQL from replica VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [module.networking.vpc_cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    local.common_tags,
    {
      Name = "${var.name_prefix}-db"
    }
  )
}

resource "aws_db_subnet_group" "replica" {
  name       = "${var.name_prefix}-db"
  subnet_ids = module.networking.private_subnet_ids

  tags = merge(
    local.common_tags,
    {
      Name = "${var.name_prefix}-db"
    }
  )
}

resource "aws_db_instance" "replica" {
  identifier                 = "${var.name_prefix}-db"
  engine                     = "postgres"
  engine_version             = var.db_engine_version
  instance_class             = var.db_instance_class
  allocated_storage          = var.db_allocated_storage
  max_allocated_storage      = var.db_max_allocated_storage
  db_name                    = var.platform_db_name
  username                   = var.db_master_username
  password                   = random_password.db_master.result
  port                       = 5432
  db_subnet_group_name       = aws_db_subnet_group.replica.name
  vpc_security_group_ids     = [aws_security_group.replica_db.id]
  storage_encrypted          = true
  publicly_accessible        = false
  apply_immediately          = true
  multi_az                   = false
  backup_retention_period    = 0
  deletion_protection        = false
  skip_final_snapshot        = true
  delete_automated_backups   = true
  auto_minor_version_upgrade = true

  tags = merge(
    local.common_tags,
    {
      Name = "${var.name_prefix}-db"
    }
  )
}

resource "aws_ecr_repository" "server" {
  name                 = local.server_repository_name
  force_delete         = true
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { Name = local.server_repository_name })
}

resource "aws_ecr_repository" "web" {
  name                 = local.web_repository_name
  force_delete         = true
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { Name = local.web_repository_name })
}

resource "aws_ecr_repository" "worker" {
  name                 = local.worker_repository_name
  force_delete         = true
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { Name = local.worker_repository_name })
}

resource "aws_ecr_repository" "customer_app" {
  name                 = local.customer_app_repository_name
  force_delete         = true
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { Name = local.customer_app_repository_name })
}

resource "aws_ecr_lifecycle_policy" "repositories" {
  for_each = {
    server       = aws_ecr_repository.server.name
    web          = aws_ecr_repository.web.name
    worker       = aws_ecr_repository.worker.name
    customer_app = aws_ecr_repository.customer_app.name
  }

  repository = each.value
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Retain the 25 most recent tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 25
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_s3_bucket" "workspace_snapshots" {
  bucket        = local.workspace_snapshot_bucket_name
  force_destroy = true
  tags          = merge(local.common_tags, { Name = local.workspace_snapshot_bucket_name })
}

resource "aws_s3_bucket_public_access_block" "workspace_snapshots" {
  bucket                  = aws_s3_bucket.workspace_snapshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id

  rule {
    id     = "expire-old-snapshots"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 14
    }
  }
}

resource "aws_s3_bucket" "alb_logs" {
  bucket        = local.alb_log_bucket_name
  force_destroy = true
  tags          = merge(local.common_tags, { Name = local.alb_log_bucket_name })
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    id     = "expire-alb-logs"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 14
    }
  }
}

data "aws_iam_policy_document" "alb_log_bucket" {
  statement {
    sid = "AllowAlbLogDeliveryAclCheck"

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.alb_logs.arn]
  }

  statement {
    sid = "AllowAlbLogDeliveryWrite"

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.alb_logs.arn}/${var.alb_log_prefix}/AWSLogs/${local.account_id}/*"
    ]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_log_bucket.json
}

resource "aws_acm_certificate" "replica" {
  domain_name               = local.root_host
  subject_alternative_names = ["*.${local.replica_domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-wildcard" })
}

resource "aws_route53_record" "acm_validation" {
  for_each = {
    for option in aws_acm_certificate.replica.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.primary.zone_id
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "replica" {
  certificate_arn         = aws_acm_certificate.replica.arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]
}

resource "aws_secretsmanager_secret" "server" {
  name                    = var.server_secret_name
  recovery_window_in_days = 0
  tags                    = merge(local.common_tags, { Name = var.server_secret_name })
}

resource "aws_secretsmanager_secret" "web" {
  name                    = var.web_secret_name
  recovery_window_in_days = 0
  tags                    = merge(local.common_tags, { Name = var.web_secret_name })
}

resource "aws_secretsmanager_secret" "worker" {
  name                    = var.worker_secret_name
  recovery_window_in_days = 0
  tags                    = merge(local.common_tags, { Name = var.worker_secret_name })
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid = "EcrPushCustomerApps"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart"
    ]

    resources = [aws_ecr_repository.customer_app.arn]
  }

  statement {
    sid = "EcrAuth"

    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "WorkspaceSnapshots"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]

    resources = [
      "${aws_s3_bucket.workspace_snapshots.arn}/${var.workspace_snapshot_prefix}/*"
    ]
  }

  statement {
    sid = "WorkspaceSnapshotList"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.workspace_snapshots.arn]
  }

  statement {
    sid = "AlbLogsRead"

    actions = [
      "s3:GetObject"
    ]

    resources = [
      "${aws_s3_bucket.alb_logs.arn}/${var.alb_log_prefix}/AWSLogs/${local.account_id}/elasticloadbalancing/${var.aws_region}/*"
    ]
  }

  statement {
    sid = "AlbLogsList"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.alb_logs.arn]
  }

  statement {
    sid = "Route53ReplicaWrites"

    actions = [
      "route53:ChangeResourceRecordSets"
    ]

    resources = [
      "arn:${data.aws_partition.current.partition}:route53:::hostedzone/${data.aws_route53_zone.primary.zone_id}"
    ]
  }

  statement {
    sid = "Route53Discovery"

    actions = [
      "route53:ListHostedZonesByName",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTags"
    ]

    resources = ["*"]
  }
}

resource "aws_iam_policy" "alb_controller" {
  name   = "${var.name_prefix}-aws-load-balancer-controller"
  policy = file("${path.module}/aws-load-balancer-controller-policy.json")
  tags   = local.common_tags
}

module "worker_irsa" {
  source = "../../../modules/irsa-role"

  inline_policy_enabled = true
  inline_policy_json    = data.aws_iam_policy_document.worker.json
  namespace             = "vibes-platform"
  oidc_provider_arn     = module.eks.oidc_provider_arn
  oidc_provider_url     = module.eks.oidc_provider_url
  role_name             = "${var.name_prefix}-worker-irsa"
  service_account_name  = "worker-sa"
  tags                  = local.common_tags
}

module "alb_controller_irsa" {
  source = "../../../modules/irsa-role"

  managed_policy_arns = {
    alb_controller = aws_iam_policy.alb_controller.arn
  }
  namespace            = "kube-system"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  role_name            = "${var.name_prefix}-aws-load-balancer-controller"
  service_account_name = "aws-load-balancer-controller"
  tags                 = local.common_tags
}

module "ebs_csi_irsa" {
  source = "../../../modules/irsa-role"

  managed_policy_arns = {
    ebs_csi = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  }
  namespace            = "kube-system"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  role_name            = "${var.name_prefix}-ebs-csi"
  service_account_name = "ebs-csi-controller-sa"
  tags                 = local.common_tags
}
