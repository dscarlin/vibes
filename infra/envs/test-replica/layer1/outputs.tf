output "account_id" {
  description = "AWS account ID for the replica environment."
  value       = data.aws_caller_identity.current.account_id
}

output "acm_certificate_arn" {
  description = "Replica wildcard ACM certificate ARN."
  value       = aws_acm_certificate_validation.replica.certificate_arn
}

output "alb_controller_irsa_role_arn" {
  description = "IRSA role ARN for the AWS Load Balancer Controller."
  value       = module.alb_controller_irsa.role_arn
}

output "alb_group_name" {
  description = "Shared ALB group name for platform and customer ingresses."
  value       = local.alb_group_name
}

output "alb_log_bucket" {
  description = "Replica ALB access log bucket name."
  value       = aws_s3_bucket.alb_logs.bucket
}

output "alb_log_prefix" {
  description = "Replica ALB access log prefix."
  value       = var.alb_log_prefix
}

output "api_host" {
  description = "Replica API hostname."
  value       = local.api_host
}

output "app_host" {
  description = "Replica app hostname."
  value       = local.app_host
}

output "aws_region" {
  description = "Replica AWS region."
  value       = var.aws_region
}

output "cluster_certificate_authority_data" {
  description = "Base64-encoded replica cluster CA data."
  value       = module.eks.cluster_certificate_authority_data
}

output "cluster_endpoint" {
  description = "Replica cluster endpoint."
  value       = module.eks.cluster_endpoint
}

output "cluster_name" {
  description = "Replica cluster name."
  value       = module.eks.cluster_name
}

output "cluster_version" {
  description = "Replica cluster version."
  value       = var.cluster_version
}

output "customer_app_repository_name" {
  description = "ECR repository name for customer app images."
  value       = aws_ecr_repository.customer_app.name
}

output "customer_app_repository_url" {
  description = "ECR repository URL for customer app images."
  value       = aws_ecr_repository.customer_app.repository_url
}

output "customer_db_admin_password" {
  description = "Replica customer DB admin password."
  value       = random_password.customer_db_admin.result
  sensitive   = true
}

output "customer_db_admin_url" {
  description = "Replica customer DB admin URL with verify-full SSL settings."
  value       = "postgresql://${urlencode(var.customer_db_admin_username)}:${urlencode(random_password.customer_db_admin.result)}@${aws_db_instance.replica.address}:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-ca.pem"
  sensitive   = true
}

output "customer_db_admin_username" {
  description = "Replica customer DB admin username."
  value       = var.customer_db_admin_username
}

output "db_host" {
  description = "Replica PostgreSQL endpoint hostname."
  value       = aws_db_instance.replica.address
}

output "db_master_password" {
  description = "Replica PostgreSQL master password."
  value       = random_password.db_master.result
  sensitive   = true
}

output "db_master_username" {
  description = "Replica PostgreSQL master username."
  value       = var.db_master_username
}

output "db_port" {
  description = "Replica PostgreSQL port."
  value       = aws_db_instance.replica.port
}

output "ebs_csi_irsa_role_arn" {
  description = "IRSA role ARN for the EBS CSI add-on."
  value       = module.ebs_csi_irsa.role_arn
}

output "platform_database_name" {
  description = "Replica platform database name."
  value       = var.platform_db_name
}

output "platform_database_password" {
  description = "Replica platform database password."
  value       = random_password.platform_db.result
  sensitive   = true
}

output "platform_database_url" {
  description = "Replica platform database URL with verify-full SSL settings."
  value       = "postgresql://${urlencode(var.platform_db_username)}:${urlencode(random_password.platform_db.result)}@${aws_db_instance.replica.address}:5432/${var.platform_db_name}?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-ca.pem"
  sensitive   = true
}

output "platform_database_username" {
  description = "Replica platform database username."
  value       = var.platform_db_username
}

output "platform_repository_url" {
  description = "Replica server image repository URL."
  value       = aws_ecr_repository.server.repository_url
}

output "replica_domain" {
  description = "Replica root hostname."
  value       = local.replica_domain
}

output "root_domain" {
  description = "Primary Route53 zone name."
  value       = var.root_domain
}

output "root_host" {
  description = "Replica root hostname."
  value       = local.root_host
}

output "route53_zone_id" {
  description = "Existing Route53 hosted zone ID used for replica DNS."
  value       = data.aws_route53_zone.primary.zone_id
}

output "server_manual_secret_name" {
  description = "Secrets Manager name for replica server runtime inputs."
  value       = aws_secretsmanager_secret.server.name
}

output "server_repository_url" {
  description = "Replica server image repository URL."
  value       = aws_ecr_repository.server.repository_url
}

output "vpc_id" {
  description = "Replica VPC ID."
  value       = module.networking.vpc_id
}

output "web_manual_secret_name" {
  description = "Secrets Manager name for replica web runtime inputs."
  value       = aws_secretsmanager_secret.web.name
}

output "web_repository_url" {
  description = "Replica web image repository URL."
  value       = aws_ecr_repository.web.repository_url
}

output "worker_irsa_role_arn" {
  description = "IRSA role ARN for the replica worker."
  value       = module.worker_irsa.role_arn
}

output "worker_manual_secret_name" {
  description = "Secrets Manager name for replica worker runtime inputs."
  value       = aws_secretsmanager_secret.worker.name
}

output "worker_repository_url" {
  description = "Replica worker image repository URL."
  value       = aws_ecr_repository.worker.repository_url
}

output "workspace_snapshot_bucket" {
  description = "Replica workspace snapshot bucket."
  value       = aws_s3_bucket.workspace_snapshots.bucket
}

output "workspace_snapshot_prefix" {
  description = "Replica workspace snapshot prefix."
  value       = var.workspace_snapshot_prefix
}
