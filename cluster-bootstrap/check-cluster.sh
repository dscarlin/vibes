#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd kubectl

prepare_replica_dirs
write_backend_files
update_kubeconfig_for_replica

log "Checking base namespaces"
for namespace in vibes-platform vibes-development vibes-testing vibes-production; do
  kubectl_retry get namespace "$namespace" >/dev/null
done

log "Checking node labels and taints"
kubectl_retry get nodes -l nodegroup=platform --no-headers | grep -q .
kubectl_retry get nodes -l nodegroup=customer --no-headers | grep -q .
kubectl_retry get nodes -l nodegroup=customer -o jsonpath='{range .items[*]}{.spec.taints[*].key}={.spec.taints[*].value}:{.spec.taints[*].effect}{"\n"}{end}' | grep -q 'nodegroup=customer:NoSchedule'

log "Checking add-ons and ingress class"
kubectl_retry -n kube-system rollout status deploy/aws-load-balancer-controller --timeout=5m
kubectl_retry get ingressclass alb >/dev/null
kubectl_retry get storageclass gp3 >/dev/null
