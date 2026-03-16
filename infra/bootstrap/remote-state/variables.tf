variable "name_prefix" {
  description = "Prefix used for the replica Terraform state resources."
  type        = string
  default     = "vibes-replica"
}

variable "lock_table_name" {
  description = "Optional explicit DynamoDB table name for Terraform state locking."
  type        = string
  default     = ""
}

variable "aws_region" {
  description = "AWS region for the remote-state bootstrap resources."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "Optional explicit S3 bucket name for Terraform state."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Additional tags to attach to the remote-state resources."
  type        = map(string)
  default     = {}
}
