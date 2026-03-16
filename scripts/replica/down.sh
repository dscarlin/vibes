#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/lib.sh"

MODE="${1:-}"

case "$MODE" in
  plan|apply) ;;
  *)
    die "usage: scripts/replica/down.sh plan|apply"
    ;;
esac

prepare_replica_dirs
write_backend_files
require_cmd aws node

REPLICA_SUFFIX="${REPLICA_SUBDOMAIN}.${REPLICA_ROOT_DOMAIN}"

print_destroy_targets() {
  cat <<EOF
[replica] Destroy target summary
- Route53 records ending in .${REPLICA_SUFFIX}.
- Replica base aliases for ${REPLICA_SUFFIX}
- Replica ECR repositories: ${REPLICA_NAME_PREFIX}-server, ${REPLICA_NAME_PREFIX}-web, ${REPLICA_NAME_PREFIX}-worker, ${REPLICA_NAME_PREFIX}-app
- Replica S3 buckets: ${REPLICA_NAME_PREFIX}-workspace-snapshots-$(replica_account_id)-${REPLICA_AWS_REGION}, ${REPLICA_NAME_PREFIX}-alb-logs-$(replica_account_id)-${REPLICA_AWS_REGION}
- Terraform Layer 2 state: EKS add-ons, namespaces, storage class, ALB controller
- Terraform Layer 1 state: EKS cluster, nodegroups, VPC, RDS, ECR repos, replica S3 buckets, ACM cert, IRSA roles, Secrets Manager contracts
- Bootstrap Terraform state bucket: $(replica_state_bucket_name)
- Bootstrap Terraform lock table: $(replica_lock_table_name)
EOF

  if [ -n "${REPLICA_ROUTE53_ZONE_ID:-}" ]; then
    log "Replica Route53 records currently present"
    node "$SCRIPT_DIR/delete-dns-records.mjs" --zone-id "$REPLICA_ROUTE53_ZONE_ID" --suffix "$REPLICA_SUFFIX" --plan || true
  else
    log "Route53 zone id not available yet; skipping DNS record enumeration"
  fi

  node "$SCRIPT_DIR/delete-bootstrap-state.mjs" \
    --bucket "$(replica_state_bucket_name)" \
    --table "$(replica_lock_table_name)" \
    --region "$REPLICA_AWS_REGION" \
    --plan || true
}

if aws s3api head-bucket --bucket "$(replica_state_bucket_name)" --region "$REPLICA_AWS_REGION" >/dev/null 2>&1; then
  terraform_remote_init "$LAYER1_DIR" "$BACKEND_DIR/layer1.backend.hcl"
  if tf -chdir="$LAYER1_DIR" output -raw route53_zone_id >/dev/null 2>&1; then
    export REPLICA_ROUTE53_ZONE_ID="$(tf -chdir="$LAYER1_DIR" output -raw route53_zone_id)"
  fi
fi

if [ "$MODE" = "plan" ]; then
  print_destroy_targets

  if aws s3api head-bucket --bucket "$(replica_state_bucket_name)" --region "$REPLICA_AWS_REGION" >/dev/null 2>&1; then
    terraform_remote_init "$LAYER1_DIR" "$BACKEND_DIR/layer1.backend.hcl"

    if tf -chdir="$LAYER1_DIR" output -raw cluster_name >/dev/null 2>&1; then
      load_layer1_outputs
      export_layer2_tf_vars

      log "Layer 2 destroy plan"
      terraform_remote_init "$LAYER2_DIR" "$BACKEND_DIR/layer2.backend.hcl"
      tf -chdir="$LAYER2_DIR" plan -destroy -input=false
    else
      log "Layer 1 outputs are not available; skipping Layer 2 destroy plan"
    fi

    log "Layer 1 destroy plan"
    tf -chdir="$LAYER1_DIR" plan -destroy -input=false || true
  else
    log "Remote state bucket not found; skipping Terraform destroy plan output"
  fi
  exit 0
fi

if ! aws s3api head-bucket --bucket "$(replica_state_bucket_name)" --region "$REPLICA_AWS_REGION" >/dev/null 2>&1; then
  die "remote state bucket $(replica_state_bucket_name) not found; refusing destroy because no replica state is available"
fi

terraform_remote_init "$LAYER1_DIR" "$BACKEND_DIR/layer1.backend.hcl"
load_layer1_outputs
export_layer2_tf_vars
export REPLICA_ROUTE53_ZONE_ID

print_destroy_targets

if aws eks describe-cluster --name "$REPLICA_CLUSTER_NAME" --region "$REPLICA_AWS_REGION" >/dev/null 2>&1; then
  log "Updating kubeconfig and removing Layer 3 workloads"
  update_kubeconfig_for_replica
  "$REPO_ROOT/deploy/destroy-platform.sh" || true
fi

log "Deleting replica Route53 records"
node "$SCRIPT_DIR/delete-dns-records.mjs" --zone-id "$REPLICA_ROUTE53_ZONE_ID" --suffix "$REPLICA_SUFFIX" --apply

log "Destroying Layer 2 cluster platform"
terraform_remote_init "$LAYER2_DIR" "$BACKEND_DIR/layer2.backend.hcl"
tf -chdir="$LAYER2_DIR" destroy -input=false -auto-approve

log "Destroying Layer 1 cloud foundation"
terraform_remote_init "$LAYER1_DIR" "$BACKEND_DIR/layer1.backend.hcl"
tf -chdir="$LAYER1_DIR" destroy -input=false -auto-approve

log "Deleting bootstrap Terraform state resources"
node "$SCRIPT_DIR/delete-bootstrap-state.mjs" \
  --bucket "$(replica_state_bucket_name)" \
  --table "$(replica_lock_table_name)" \
  --region "$REPLICA_AWS_REGION" \
  --apply

log "Clearing local Terraform working directories"
reset_terraform_workdirs
