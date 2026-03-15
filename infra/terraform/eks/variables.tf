variable "region" {
  type    = string
  default = "us-east-1"
}

variable "cluster_name" {
  type    = string
  default = "vibes-eks"
}

variable "vpc_cidr" {
  type    = string
  default = "10.10.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.10.1.0/24", "10.10.2.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.10.11.0/24", "10.10.12.0/24"]
}

variable "node_instance_type" {
  type    = string
  default = "t3.large"
}

variable "node_desired" {
  type    = number
  default = 2
}

variable "node_min" {
  type    = number
  default = 1
}

variable "node_max" {
  type    = number
  default = 4
}

variable "workspace_snapshot_bucket_name" {
  type    = string
  default = ""
}
