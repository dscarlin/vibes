locals {
  base_tags = merge(
    {
      Name         = var.cluster_name
      "managed-by" = "terraform"
    },
    var.tags
  )

  node_policy_arns = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  ])
}

data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

data "aws_iam_policy_document" "cluster_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.cluster_name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume_role.json
  tags               = local.base_tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
  ])

  role       = aws_iam_role.cluster.name
  policy_arn = each.value
}

resource "aws_eks_cluster" "this" {
  name     = var.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.cluster_version

  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = var.endpoint_private_access
    endpoint_public_access  = var.endpoint_public_access
  }

  tags = local.base_tags

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

data "aws_iam_policy_document" "node_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "platform_nodes" {
  name               = "${var.platform_nodegroup_name}-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json
  tags               = local.base_tags
}

resource "aws_iam_role_policy_attachment" "platform_nodes" {
  for_each = local.node_policy_arns

  role       = aws_iam_role.platform_nodes.name
  policy_arn = each.value
}

resource "aws_iam_role" "customer_nodes" {
  name               = "${var.customer_nodegroup_name}-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json
  tags               = local.base_tags
}

resource "aws_iam_role_policy_attachment" "customer_nodes" {
  for_each = local.node_policy_arns

  role       = aws_iam_role.customer_nodes.name
  policy_arn = each.value
}

resource "aws_eks_node_group" "platform" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = var.platform_nodegroup_name
  node_role_arn   = aws_iam_role.platform_nodes.arn
  subnet_ids      = var.subnet_ids
  disk_size       = var.node_disk_size
  instance_types  = var.platform_node_instance_types

  labels = {
    nodegroup = "platform"
    role      = "platform"
  }

  scaling_config {
    desired_size = var.platform_node_desired_size
    min_size     = var.platform_node_min_size
    max_size     = var.platform_node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  tags = merge(
    local.base_tags,
    {
      Name = var.platform_nodegroup_name
    }
  )

  depends_on = [aws_iam_role_policy_attachment.platform_nodes]
}

resource "aws_eks_node_group" "customer" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = var.customer_nodegroup_name
  node_role_arn   = aws_iam_role.customer_nodes.arn
  subnet_ids      = var.subnet_ids
  disk_size       = var.node_disk_size
  instance_types  = var.customer_node_instance_types

  labels = {
    nodegroup = "customer"
    role      = "customer"
  }

  taint {
    key    = "nodegroup"
    value  = "customer"
    effect = "NO_SCHEDULE"
  }

  scaling_config {
    desired_size = var.customer_node_desired_size
    min_size     = var.customer_node_min_size
    max_size     = var.customer_node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  tags = merge(
    local.base_tags,
    {
      Name = var.customer_nodegroup_name
    }
  )

  depends_on = [aws_iam_role_policy_attachment.customer_nodes]
}

resource "aws_iam_openid_connect_provider" "this" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer

  tags = local.base_tags
}
