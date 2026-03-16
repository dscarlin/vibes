#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd kubectl

update_kubeconfig_for_replica || true

if [ -f "$METADATA_ENV_FILE" ]; then
  source_env_file "$METADATA_ENV_FILE"
fi

PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-vibes-platform}"
DEVELOPMENT_NAMESPACE="${DEVELOPMENT_NAMESPACE:-vibes-development}"
TESTING_NAMESPACE="${TESTING_NAMESPACE:-vibes-testing}"
PRODUCTION_NAMESPACE="${PRODUCTION_NAMESPACE:-vibes-production}"
PLATFORM_SERVER_NAME="${PLATFORM_SERVER_NAME:-vibes-server}"
PLATFORM_WEB_NAME="${PLATFORM_WEB_NAME:-vibes-web}"
PLATFORM_WORKER_NAME="${PLATFORM_WORKER_NAME:-vibes-worker}"
PLATFORM_REDIS_NAME="${PLATFORM_REDIS_NAME:-redis}"
PLATFORM_SERVER_ENV_SECRET_NAME="${PLATFORM_SERVER_ENV_SECRET_NAME:-${PLATFORM_SERVER_NAME}-env}"
PLATFORM_WEB_ENV_SECRET_NAME="${PLATFORM_WEB_ENV_SECRET_NAME:-${PLATFORM_WEB_NAME}-env}"
PLATFORM_WORKER_ENV_SECRET_NAME="${PLATFORM_WORKER_ENV_SECRET_NAME:-${PLATFORM_WORKER_NAME}-env}"
PLATFORM_RDS_CA_SECRET_NAME="${PLATFORM_RDS_CA_SECRET_NAME:-rds-ca-bundle}"
PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME="${PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME:-vibes-admin-metrics-read}"
PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME="${PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME:-vibes-admin-metrics-read}"
PLATFORM_WORKER_CLUSTER_ROLE_NAME="${PLATFORM_WORKER_CLUSTER_ROLE_NAME:-worker-deployer}"
PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME="${PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME:-worker-deployer}"
DELETE_PLATFORM_CLUSTER_ROLES="${DELETE_PLATFORM_CLUSTER_ROLES:-true}"

delete_dynamic_namespace_resources() {
  namespace="$1"

  kubectl -n "$namespace" delete ingress --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete targetgroupbinding --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete service --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete deployment --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete pod --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete pvc --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete secret --all --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

wait_for_namespace_alb_cleanup() {
  namespace="$1"
  attempts="${2:-60}"
  delay_seconds="${3:-5}"
  count=1

  while [ "$count" -le "$attempts" ]; do
    remaining_ingresses="$(kubectl -n "$namespace" get ingress -o name 2>/dev/null || true)"
    remaining_targetgroupbindings="$(kubectl -n "$namespace" get targetgroupbinding -o name 2>/dev/null || true)"

    if [ -z "$remaining_ingresses" ] && [ -z "$remaining_targetgroupbindings" ]; then
      return 0
    fi

    sleep "$delay_seconds"
    count=$((count + 1))
  done

  return 1
}

kubectl -n "$PLATFORM_NAMESPACE" delete ingress "$PLATFORM_SERVER_NAME" "$PLATFORM_WEB_NAME" --ignore-not-found
kubectl -n "$PLATFORM_NAMESPACE" delete deploy "$PLATFORM_SERVER_NAME" "$PLATFORM_WEB_NAME" "$PLATFORM_WORKER_NAME" "$PLATFORM_REDIS_NAME" --ignore-not-found
kubectl -n "$PLATFORM_NAMESPACE" delete service "$PLATFORM_SERVER_NAME" "$PLATFORM_WEB_NAME" "$PLATFORM_REDIS_NAME" --ignore-not-found
kubectl -n "$PLATFORM_NAMESPACE" delete secret "$PLATFORM_SERVER_ENV_SECRET_NAME" "$PLATFORM_WEB_ENV_SECRET_NAME" "$PLATFORM_WORKER_ENV_SECRET_NAME" "$PLATFORM_RDS_CA_SECRET_NAME" --ignore-not-found
kubectl delete clusterrolebinding "$PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME" "$PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME" --ignore-not-found
if [ "$DELETE_PLATFORM_CLUSTER_ROLES" = "true" ]; then
  kubectl delete clusterrole "$PLATFORM_WORKER_CLUSTER_ROLE_NAME" "$PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME" --ignore-not-found
fi

for namespace in "$DEVELOPMENT_NAMESPACE" "$TESTING_NAMESPACE" "$PRODUCTION_NAMESPACE"; do
  delete_dynamic_namespace_resources "$namespace"
done
for namespace in "$DEVELOPMENT_NAMESPACE" "$TESTING_NAMESPACE" "$PRODUCTION_NAMESPACE"; do
  wait_for_namespace_alb_cleanup "$namespace" || log "Timed out waiting for ${namespace} ingress cleanup; remaining ALB resources may still be deleting"
done

log "Replica Layer 3 workloads deleted"
