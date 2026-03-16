variable "alb_controller_chart_version" {
  description = "Pinned Helm chart version for the AWS Load Balancer Controller."
  type        = string
  default     = "3.1.0"
}

variable "alb_controller_role_arn" {
  description = "IRSA role ARN for the AWS Load Balancer Controller."
  type        = string
}

variable "aws_region" {
  description = "AWS region for the replica cluster."
  type        = string
  default     = "us-east-1"
}

variable "cluster_certificate_authority_data" {
  description = "Base64-encoded cluster CA data."
  type        = string
}

variable "cluster_endpoint" {
  description = "Replica cluster endpoint."
  type        = string
}

variable "cluster_name" {
  description = "Replica cluster name."
  type        = string
}

variable "coredns_addon_version" {
  description = "Pinned coredns EKS add-on version."
  type        = string
  default     = "v1.13.2-eksbuild.1"
}

variable "ebs_csi_addon_version" {
  description = "Pinned EBS CSI EKS add-on version."
  type        = string
  default     = "v1.56.0-eksbuild.1"
}

variable "ebs_csi_role_arn" {
  description = "IRSA role ARN for the EBS CSI add-on."
  type        = string
}

variable "ingress_class_name" {
  description = "Ingress class name exposed by the AWS Load Balancer Controller."
  type        = string
  default     = "alb"
}

variable "kube_proxy_addon_version" {
  description = "Pinned kube-proxy EKS add-on version."
  type        = string
  default     = "v1.34.3-eksbuild.5"
}

variable "metrics_server_addon_version" {
  description = "Pinned metrics-server EKS add-on version."
  type        = string
  default     = "v0.8.1-eksbuild.2"
}

variable "namespaces" {
  description = "Base namespaces needed by the replica platform."
  type        = list(string)
  default     = ["vibes-platform", "vibes-development", "vibes-testing", "vibes-production"]
}

variable "tags" {
  description = "Additional tags propagated to AWS-managed add-ons."
  type        = map(string)
  default     = {}
}

variable "vpc_cni_addon_version" {
  description = "Pinned VPC CNI EKS add-on version."
  type        = string
  default     = "v1.21.1-eksbuild.3"
}

variable "vpc_id" {
  description = "Replica VPC ID."
  type        = string
}
