variable "alb_log_prefix" {
  description = "Replica ALB access log prefix inside the dedicated S3 bucket."
  type        = string
  default     = "alb-logs"
}

variable "aws_region" {
  description = "AWS region for the test replica."
  type        = string
  default     = "us-east-1"
}

variable "az_count" {
  description = "Number of AZs to use when laying out the replica VPC."
  type        = number
  default     = 2
}

variable "cluster_name" {
  description = "Optional explicit cluster name. Defaults to name_prefix."
  type        = string
  default     = ""
}

variable "cluster_version" {
  description = "Replica EKS Kubernetes version."
  type        = string
  default     = "1.34"
}

variable "customer_db_admin_username" {
  description = "Role used by the worker to create per-project customer databases."
  type        = string
  default     = "vibes_admin"
}

variable "customer_node_desired_size" {
  description = "Desired size for the tainted customer nodegroup."
  type        = number
  default     = 1
}

variable "customer_node_instance_type" {
  description = "Instance type for the tainted customer nodegroup."
  type        = string
  default     = "t3.medium"
}

variable "customer_node_max_size" {
  description = "Maximum size for the tainted customer nodegroup."
  type        = number
  default     = 2
}

variable "customer_node_min_size" {
  description = "Minimum size for the tainted customer nodegroup."
  type        = number
  default     = 1
}

variable "db_allocated_storage" {
  description = "Initial allocated storage for the replica PostgreSQL instance."
  type        = number
  default     = 30
}

variable "db_engine_version" {
  description = "Replica PostgreSQL engine version."
  type        = string
  default     = "16.10"
}

variable "db_instance_class" {
  description = "Instance class for the replica PostgreSQL instance."
  type        = string
  default     = "db.t3.medium"
}

variable "db_master_username" {
  description = "Master username for the replica PostgreSQL instance."
  type        = string
  default     = "postgres"
}

variable "db_max_allocated_storage" {
  description = "Maximum autoscaled storage for the replica PostgreSQL instance."
  type        = number
  default     = 100
}

variable "name_prefix" {
  description = "Replica resource prefix."
  type        = string
  default     = "vibes-replica"
}

variable "node_disk_size" {
  description = "Root volume size in GiB for the EKS nodegroups."
  type        = number
  default     = 80
}

variable "platform_db_name" {
  description = "Logical platform database name."
  type        = string
  default     = "vibes_platform"
}

variable "platform_db_username" {
  description = "Role used by the server and worker for platform metadata access."
  type        = string
  default     = "vibes_platform"
}

variable "platform_node_desired_size" {
  description = "Desired size for the platform nodegroup."
  type        = number
  default     = 1
}

variable "platform_node_instance_type" {
  description = "Instance type for the platform nodegroup."
  type        = string
  default     = "t3.medium"
}

variable "platform_node_max_size" {
  description = "Maximum size for the platform nodegroup."
  type        = number
  default     = 2
}

variable "platform_node_min_size" {
  description = "Minimum size for the platform nodegroup."
  type        = number
  default     = 1
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs for the replica VPC."
  type        = list(string)
  default     = ["10.90.128.0/20", "10.90.144.0/20"]
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs for the replica VPC."
  type        = list(string)
  default     = ["10.90.0.0/20", "10.90.16.0/20"]
}

variable "replica_subdomain" {
  description = "Replica subdomain rooted under the primary Route53 zone."
  type        = string
  default     = "replica"
}

variable "root_domain" {
  description = "Primary public domain that already exists in Route53."
  type        = string
  default     = "vibesplatform.ai"
}

variable "server_secret_name" {
  description = "Secrets Manager name for the replica server runtime contract."
  type        = string
  default     = "/vibes/test-replica/server"
}

variable "tags" {
  description = "Additional tags to attach to all replica resources."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR block for the replica VPC."
  type        = string
  default     = "10.90.0.0/16"
}

variable "web_secret_name" {
  description = "Secrets Manager name for the replica web runtime contract."
  type        = string
  default     = "/vibes/test-replica/web"
}

variable "worker_secret_name" {
  description = "Secrets Manager name for the replica worker runtime contract."
  type        = string
  default     = "/vibes/test-replica/worker"
}

variable "workspace_snapshot_prefix" {
  description = "S3 prefix used by the worker for workspace snapshots."
  type        = string
  default     = "project-workspaces"
}
