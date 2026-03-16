output "gp3_storage_class_name" {
  description = "Name of the replica workspace storage class."
  value       = kubernetes_storage_class_v1.gp3.metadata[0].name
}

output "namespaces" {
  description = "Replica namespaces created for the platform."
  value       = [for namespace in kubernetes_namespace_v1.base : namespace.metadata[0].name]
}
