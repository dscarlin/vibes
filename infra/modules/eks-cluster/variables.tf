variable "cluster_name" {
  description = "Replica EKS cluster name."
  type        = string
}

variable "cluster_version" {
  description = "Replica EKS Kubernetes version."
  type        = string
}

variable "customer_node_desired_size" {
  description = "Desired node count for the tainted customer nodegroup."
  type        = number
}

variable "customer_node_instance_types" {
  description = "Instance types for the customer nodegroup."
  type        = list(string)
}

variable "customer_node_max_size" {
  description = "Maximum size for the customer nodegroup."
  type        = number
}

variable "customer_node_min_size" {
  description = "Minimum size for the customer nodegroup."
  type        = number
}

variable "customer_nodegroup_name" {
  description = "Managed nodegroup name for customer workloads."
  type        = string
}

variable "endpoint_private_access" {
  description = "Enable private endpoint access for the EKS control plane."
  type        = bool
  default     = true
}

variable "endpoint_public_access" {
  description = "Enable public endpoint access for the EKS control plane."
  type        = bool
  default     = true
}

variable "node_disk_size" {
  description = "Root volume size in GiB for both nodegroups."
  type        = number
  default     = 80
}

variable "platform_node_desired_size" {
  description = "Desired node count for the platform nodegroup."
  type        = number
}

variable "platform_node_instance_types" {
  description = "Instance types for the platform nodegroup."
  type        = list(string)
}

variable "platform_node_max_size" {
  description = "Maximum size for the platform nodegroup."
  type        = number
}

variable "platform_node_min_size" {
  description = "Minimum size for the platform nodegroup."
  type        = number
}

variable "platform_nodegroup_name" {
  description = "Managed nodegroup name for platform workloads."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for the cluster and nodegroups."
  type        = list(string)
}

variable "tags" {
  description = "Additional tags applied to all cluster resources."
  type        = map(string)
  default     = {}
}
