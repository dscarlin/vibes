provider "aws" {
  region = var.aws_region
}

data "aws_eks_cluster_auth" "replica" {
  name = var.cluster_name
}

provider "kubernetes" {
  host                   = var.cluster_endpoint
  cluster_ca_certificate = base64decode(var.cluster_certificate_authority_data)
  token                  = data.aws_eks_cluster_auth.replica.token
}

provider "helm" {
  kubernetes {
    host                   = var.cluster_endpoint
    cluster_ca_certificate = base64decode(var.cluster_certificate_authority_data)
    token                  = data.aws_eks_cluster_auth.replica.token
  }
}
