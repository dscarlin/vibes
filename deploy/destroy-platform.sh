#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd kubectl

update_kubeconfig_for_replica || true

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

kubectl -n vibes-platform delete ingress vibes-server vibes-web --ignore-not-found
kubectl -n vibes-platform delete deploy vibes-server vibes-web vibes-worker redis --ignore-not-found
kubectl -n vibes-platform delete service vibes-server vibes-web redis --ignore-not-found
kubectl -n vibes-platform delete secret vibes-server-env vibes-web-env vibes-worker-env rds-ca-bundle --ignore-not-found
kubectl delete clusterrolebinding worker-deployer vibes-admin-metrics-read --ignore-not-found
kubectl delete clusterrole worker-deployer vibes-admin-metrics-read --ignore-not-found

delete_dynamic_namespace_resources vibes-development
delete_dynamic_namespace_resources vibes-testing
wait_for_namespace_alb_cleanup vibes-development || log "Timed out waiting for development ingress cleanup; Layer 2 destroy may need to finish remaining ALB resources"

log "Replica Layer 3 workloads deleted"
