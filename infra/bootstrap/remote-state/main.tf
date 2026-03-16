provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}
locals {
  state_bucket_name = trimspace(var.state_bucket_name) != "" ? trimspace(var.state_bucket_name) : "${var.name_prefix}-tfstate-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  lock_table_name   = trimspace(var.lock_table_name) != "" ? trimspace(var.lock_table_name) : "${var.name_prefix}-terraform-locks"

  tags = merge(
    {
      Name         = "${var.name_prefix}-tfstate"
      "vibes:env"  = "test-replica"
      "managed-by" = "terraform"
      "layer"      = "bootstrap"
    },
    var.tags
  )
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = local.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  tags         = local.tags

  attribute {
    name = "LockID"
    type = "S"
  }
}
