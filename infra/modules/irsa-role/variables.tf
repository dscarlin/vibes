variable "inline_policy_json" {
  description = "Optional inline policy JSON for the IRSA role."
  type        = string
  default     = ""
}

variable "inline_policy_enabled" {
  description = "Whether to create the inline policy attachment for this IRSA role."
  type        = bool
  default     = false
}

variable "managed_policy_arns" {
  description = "Managed policies to attach to the IRSA role."
  type        = map(string)
  default     = {}
}

variable "namespace" {
  description = "Kubernetes namespace of the service account."
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the EKS OIDC provider."
  type        = string
}

variable "oidc_provider_url" {
  description = "Issuer URL of the EKS OIDC provider."
  type        = string
}

variable "role_name" {
  description = "IAM role name."
  type        = string
}

variable "service_account_name" {
  description = "Kubernetes service account name."
  type        = string
}

variable "tags" {
  description = "Tags applied to the IRSA role."
  type        = map(string)
  default     = {}
}
