output "private_subnet_ids" {
  description = "Private subnet IDs for EKS nodes and RDS."
  value       = [for subnet in values(aws_subnet.private) : subnet.id]
}

output "public_subnet_ids" {
  description = "Public subnet IDs used for internet-facing load balancers."
  value       = [for subnet in values(aws_subnet.public) : subnet.id]
}

output "vpc_cidr_block" {
  description = "CIDR block of the replica VPC."
  value       = aws_vpc.this.cidr_block
}

output "vpc_id" {
  description = "Replica VPC ID."
  value       = aws_vpc.this.id
}
