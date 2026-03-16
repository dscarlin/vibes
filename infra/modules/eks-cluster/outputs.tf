output "cluster_arn" {
  description = "Replica EKS cluster ARN."
  value       = aws_eks_cluster.this.arn
}

output "cluster_certificate_authority_data" {
  description = "Base64-encoded cluster CA data."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_endpoint" {
  description = "Replica EKS cluster endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_name" {
  description = "Replica EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_security_group_id" {
  description = "Security group automatically created for the EKS control plane."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "customer_node_role_arn" {
  description = "IAM role ARN used by the customer nodegroup."
  value       = aws_iam_role.customer_nodes.arn
}

output "customer_nodegroup_name" {
  description = "Customer nodegroup name."
  value       = aws_eks_node_group.customer.node_group_name
}

output "oidc_provider_arn" {
  description = "OIDC provider ARN for IRSA roles."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "oidc_provider_url" {
  description = "OIDC provider URL for IRSA trust configuration."
  value       = aws_iam_openid_connect_provider.this.url
}

output "platform_node_role_arn" {
  description = "IAM role ARN used by the platform nodegroup."
  value       = aws_iam_role.platform_nodes.arn
}

output "platform_nodegroup_name" {
  description = "Platform nodegroup name."
  value       = aws_eks_node_group.platform.node_group_name
}
