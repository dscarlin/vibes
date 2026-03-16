#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/lib.sh"

MODE="${1:-}"

case "$MODE" in
  plan|apply) ;;
  *)
    die "usage: scripts/replica/up.sh plan|apply"
    ;;
esac

prepare_replica_dirs
export_layer1_tf_vars
write_backend_files

if [ "$MODE" = "plan" ]; then
  require_cmd aws

  log "Bootstrap remote-state plan"
  terraform_local_init "$BOOTSTRAP_DIR"
  export TF_VAR_name_prefix="$REPLICA_NAME_PREFIX"
  export TF_VAR_state_bucket_name="$(replica_state_bucket_name)"
  export TF_VAR_lock_table_name="$(replica_lock_table_name)"
  tf -chdir="$BOOTSTRAP_DIR" plan -input=false

  log "Layer 1 cloud foundation plan"
  terraform_local_init "$LAYER1_DIR"
  tf -chdir="$LAYER1_DIR" plan -input=false

  cat <<EOF
[replica] Layer 2 planned resources after Layer 1 exists
- EKS add-ons: vpc-cni, coredns, kube-proxy, metrics-server, aws-ebs-csi-driver
- AWS Load Balancer Controller Helm release with IRSA-backed service account
- Namespaces: vibes-platform, vibes-development, vibes-testing, vibes-production
- StorageClass: gp3

[replica] Layer 3 planned actions
- Build and push replica-specific server, web, and worker images
- Sync runtime secrets from Secrets Manager into Kubernetes secrets
- Deploy redis, vibes-server, vibes-web, and vibes-worker behind a shared ALB
- Create base DNS aliases for ${REPLICA_SUBDOMAIN}.${REPLICA_ROOT_DOMAIN}
- Run end-to-end validation and save evidence under validation/evidence/
EOF
  exit 0
fi

require_cmd aws kubectl docker envsubst node git

log "Applying bootstrap remote state"
bootstrap_remote_state_apply

log "Applying Layer 1 cloud foundation"
terraform_remote_init "$LAYER1_DIR" "$BACKEND_DIR/layer1.backend.hcl"
tf -chdir="$LAYER1_DIR" apply -input=false -auto-approve

log "Configuring kubeconfig for the replica cluster"
update_kubeconfig_for_replica
load_layer1_outputs

if [ "${REPLICA_SEED_FROM_LOCAL_ENV:-true}" = "true" ]; then
  log "Seeding replica Secrets Manager values from local env files"
  node "$REPO_ROOT/scripts/replica/seed-secrets.mjs" apply
fi

log "Planning Layer 2 cluster platform"
export_layer2_tf_vars
terraform_remote_init "$LAYER2_DIR" "$BACKEND_DIR/layer2.backend.hcl"
tf -chdir="$LAYER2_DIR" plan -input=false

log "Applying Layer 2 cluster platform"
tf -chdir="$LAYER2_DIR" apply -input=false -auto-approve

log "Running cluster bootstrap checks"
"$REPO_ROOT/cluster-bootstrap/check-cluster.sh"

log "Initializing the replica database roles and ownership"
"$REPO_ROOT/cluster-bootstrap/init-database.sh"

log "Synthesizing replica runtime env files from Terraform outputs and Secrets Manager"
node "$REPO_ROOT/cluster-bootstrap/sync-secrets.mjs"

log "Building and pushing replica platform images"
"$REPO_ROOT/deploy/build-push.sh"

log "Deploying replica platform workloads"
"$REPO_ROOT/deploy/apply-platform.sh"

log "Running end-to-end replica validation"
node "$REPO_ROOT/validation/run-replica-flow.mjs"
