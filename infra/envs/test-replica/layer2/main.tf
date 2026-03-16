locals {
  common_tags = merge(
    {
      "vibes:env"  = "test-replica"
      "managed-by" = "terraform"
      "layer"      = "cluster-platform"
    },
    var.tags
  )
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = var.cluster_name
  addon_name                  = "vpc-cni"
  addon_version               = var.vpc_cni_addon_version
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.common_tags
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = var.cluster_name
  addon_name                  = "coredns"
  addon_version               = var.coredns_addon_version
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.common_tags
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = var.cluster_name
  addon_name                  = "kube-proxy"
  addon_version               = var.kube_proxy_addon_version
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.common_tags
}

resource "aws_eks_addon" "metrics_server" {
  cluster_name                = var.cluster_name
  addon_name                  = "metrics-server"
  addon_version               = var.metrics_server_addon_version
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.common_tags
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = var.cluster_name
  addon_name                  = "aws-ebs-csi-driver"
  addon_version               = var.ebs_csi_addon_version
  service_account_role_arn    = var.ebs_csi_role_arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.common_tags
}

resource "kubernetes_namespace_v1" "base" {
  for_each = toset(var.namespaces)

  metadata {
    name = each.value
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

resource "kubernetes_service_account_v1" "aws_load_balancer_controller" {
  metadata {
    name      = "aws-load-balancer-controller"
    namespace = "kube-system"
    annotations = {
      "eks.amazonaws.com/role-arn" = var.alb_controller_role_arn
    }
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = var.alb_controller_chart_version
  namespace  = "kube-system"

  cleanup_on_fail = true
  max_history     = 5
  timeout         = 600
  wait            = true

  set {
    name  = "clusterName"
    value = var.cluster_name
  }

  set {
    name  = "region"
    value = var.aws_region
  }

  set {
    name  = "vpcId"
    value = var.vpc_id
  }

  set {
    name  = "serviceAccount.create"
    value = "false"
  }

  set {
    name  = "serviceAccount.name"
    value = kubernetes_service_account_v1.aws_load_balancer_controller.metadata[0].name
  }

  set {
    name  = "ingressClass"
    value = var.ingress_class_name
  }

  set {
    name  = "replicaCount"
    value = "1"
  }

  depends_on = [
    aws_eks_addon.vpc_cni,
    aws_eks_addon.coredns,
    aws_eks_addon.kube_proxy,
    aws_eks_addon.metrics_server,
    kubernetes_service_account_v1.aws_load_balancer_controller
  ]
}

resource "kubernetes_storage_class_v1" "gp3" {
  metadata {
    name = "gp3"
    annotations = {
      "storageclass.kubernetes.io/is-default-class" = "false"
    }
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  storage_provisioner    = "ebs.csi.aws.com"
  allow_volume_expansion = true
  reclaim_policy         = "Delete"
  volume_binding_mode    = "WaitForFirstConsumer"

  parameters = {
    type   = "gp3"
    fsType = "ext4"
  }

  depends_on = [aws_eks_addon.ebs_csi]
}
