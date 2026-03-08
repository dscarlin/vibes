resource "aws_ecr_repository" "customer_apps" {
  name                 = "vibes-customer-apps"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

output "ecr_repository_url" {
  value = aws_ecr_repository.customer_apps.repository_url
}
