variable "availability_zones" {
  description = "Availability zones to use for the replica VPC."
  type        = list(string)
}

variable "cluster_name" {
  description = "EKS cluster name used for subnet tagging."
  type        = string
}

variable "name_prefix" {
  description = "Prefix used for VPC resource naming."
  type        = string
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs in the same order as availability_zones."
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs in the same order as availability_zones."
  type        = list(string)
}

variable "single_nat_gateway" {
  description = "Whether to use a single NAT gateway for all private subnets."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags applied to all resources."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR block for the replica VPC."
  type        = string
}
