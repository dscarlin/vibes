#!/usr/bin/env sh
set -eu

if [ -z "${REPO_ROOT:-}" ]; then
  CALLER_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
  REPO_ROOT="$(CDPATH='' cd -- "$CALLER_DIR/../.." && pwd)"
fi

BOOTSTRAP_DIR="$REPO_ROOT/infra/bootstrap/remote-state"
REPLICA_ENV_DIR="$REPO_ROOT/infra/envs/test-replica"
LAYER1_DIR="$REPLICA_ENV_DIR/layer1"
LAYER2_DIR="$REPLICA_ENV_DIR/layer2"
GENERATED_DIR="${REPLICA_OUTPUT_DIR:-$REPO_ROOT/deploy/.generated/replica}"
BACKEND_DIR="$GENERATED_DIR/backend"
METADATA_ENV_FILE="$GENERATED_DIR/metadata.env"
IMAGES_ENV_FILE="$GENERATED_DIR/images.env"
SERVER_ENV_FILE="$GENERATED_DIR/server.env"
WEB_ENV_FILE="$GENERATED_DIR/web.env"
WORKER_ENV_FILE="$GENERATED_DIR/worker.env"
VALIDATION_EVIDENCE_DIR="${REPLICA_VALIDATION_EVIDENCE_DIR:-$REPO_ROOT/validation/evidence}"
TF_BIN="$REPO_ROOT/scripts/replica/terraformw.sh"

REPLICA_AWS_REGION="${REPLICA_AWS_REGION:-us-east-1}"
REPLICA_NAME_PREFIX="${REPLICA_NAME_PREFIX:-vibes-replica}"
REPLICA_ROOT_DOMAIN="${REPLICA_ROOT_DOMAIN:-vibesplatform.ai}"
REPLICA_SUBDOMAIN="${REPLICA_SUBDOMAIN:-replica}"

log() {
  printf '[replica] %s\n' "$*"
}

die() {
  printf '[replica] %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      die "required command not found: $cmd"
    fi
  done
}

is_transient_kubectl_error() {
  case "$1" in
    *"TLS handshake timeout"* | *"Client.Timeout exceeded"* | *"i/o timeout"* | *"EOF"* | *"connection refused"* | *"context deadline exceeded"* | *"ServiceUnavailable"* | *"the server was unable to return a response in the time allotted"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

kubectl_retry() {
  attempts="${KUBECTL_RETRY_ATTEMPTS:-12}"
  delay_seconds="${KUBECTL_RETRY_DELAY_SECONDS:-5}"
  count=1

  while :; do
    if output="$(kubectl "$@" 2>&1)"; then
      if [ -n "$output" ]; then
        printf '%s\n' "$output"
      fi
      return 0
    fi

    status=$?
    if ! is_transient_kubectl_error "$output"; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi

    if [ "$count" -ge "$attempts" ]; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi

    log "kubectl transient failure, retrying in ${delay_seconds}s: $output"
    sleep "$delay_seconds"
    count=$((count + 1))
  done
}

tf() {
  "$TF_BIN" "$@"
}

prepare_replica_dirs() {
  mkdir -p "$BACKEND_DIR" "$GENERATED_DIR" "$VALIDATION_EVIDENCE_DIR"
}

replica_account_id() {
  aws sts get-caller-identity --query 'Account' --output text --region "$REPLICA_AWS_REGION"
}

replica_state_bucket_name() {
  printf '%s-tfstate-%s-%s\n' "$REPLICA_NAME_PREFIX" "$(replica_account_id)" "$REPLICA_AWS_REGION"
}

replica_lock_table_name() {
  printf '%s-terraform-locks\n' "$REPLICA_NAME_PREFIX"
}

write_backend_files() {
  prepare_replica_dirs

  cat >"$BACKEND_DIR/layer1.backend.hcl" <<EOF
bucket         = "$(replica_state_bucket_name)"
key            = "test-replica/layer1/terraform.tfstate"
region         = "${REPLICA_AWS_REGION}"
dynamodb_table = "$(replica_lock_table_name)"
encrypt        = true
EOF

  cat >"$BACKEND_DIR/layer2.backend.hcl" <<EOF
bucket         = "$(replica_state_bucket_name)"
key            = "test-replica/layer2/terraform.tfstate"
region         = "${REPLICA_AWS_REGION}"
dynamodb_table = "$(replica_lock_table_name)"
encrypt        = true
EOF
}

source_env_file() {
  file_path="$1"
  if [ ! -f "$file_path" ]; then
    die "required env file not found: $file_path"
  fi
  set -a
  # shellcheck disable=SC1090
  . "$file_path"
  set +a
}

export_layer1_tf_vars() {
  export TF_VAR_aws_region="$REPLICA_AWS_REGION"
  export TF_VAR_name_prefix="$REPLICA_NAME_PREFIX"
  export TF_VAR_root_domain="$REPLICA_ROOT_DOMAIN"
  export TF_VAR_replica_subdomain="$REPLICA_SUBDOMAIN"

  if [ -n "${REPLICA_CLUSTER_VERSION:-}" ]; then
    export TF_VAR_cluster_version="$REPLICA_CLUSTER_VERSION"
  fi
  if [ -n "${REPLICA_PLATFORM_NODE_INSTANCE_TYPE:-}" ]; then
    export TF_VAR_platform_node_instance_type="$REPLICA_PLATFORM_NODE_INSTANCE_TYPE"
  fi
  if [ -n "${REPLICA_CUSTOMER_NODE_INSTANCE_TYPE:-}" ]; then
    export TF_VAR_customer_node_instance_type="$REPLICA_CUSTOMER_NODE_INSTANCE_TYPE"
  fi
  if [ -n "${REPLICA_PLATFORM_NODE_DESIRED_SIZE:-}" ]; then
    export TF_VAR_platform_node_desired_size="$REPLICA_PLATFORM_NODE_DESIRED_SIZE"
  fi
  if [ -n "${REPLICA_CUSTOMER_NODE_DESIRED_SIZE:-}" ]; then
    export TF_VAR_customer_node_desired_size="$REPLICA_CUSTOMER_NODE_DESIRED_SIZE"
  fi
  if [ -n "${REPLICA_DB_INSTANCE_CLASS:-}" ]; then
    export TF_VAR_db_instance_class="$REPLICA_DB_INSTANCE_CLASS"
  fi
}

bootstrap_remote_state_apply() {
  export TF_VAR_name_prefix="$REPLICA_NAME_PREFIX"
  export TF_VAR_state_bucket_name="$(replica_state_bucket_name)"
  export TF_VAR_lock_table_name="$(replica_lock_table_name)"

  tf -chdir="$BOOTSTRAP_DIR" init -input=false >/dev/null
  tf -chdir="$BOOTSTRAP_DIR" apply -input=false -auto-approve
}

terraform_local_init() {
  tf -chdir="$1" init -backend=false -input=false >/dev/null
}

terraform_remote_init() {
  layer_dir="$1"
  backend_file="$2"
  tf -chdir="$layer_dir" init -reconfigure -input=false -backend-config="$backend_file" >/dev/null
}

reset_terraform_workdirs() {
  for dir in "$BOOTSTRAP_DIR" "$LAYER1_DIR" "$LAYER2_DIR"; do
    rm -rf "$dir/.terraform" "$dir/terraform.tfstate" "$dir/terraform.tfstate.backup"
  done
}

layer1_output_raw() {
  tf -chdir="$LAYER1_DIR" output -raw "$1"
}

load_layer1_outputs() {
  export REPLICA_ACCOUNT_ID="$(layer1_output_raw account_id)"
  export REPLICA_CLUSTER_NAME="$(layer1_output_raw cluster_name)"
  export REPLICA_CLUSTER_ENDPOINT="$(layer1_output_raw cluster_endpoint)"
  export REPLICA_ROOT_HOST="$(layer1_output_raw root_host)"
  export REPLICA_APP_HOST="$(layer1_output_raw app_host)"
  export REPLICA_API_HOST="$(layer1_output_raw api_host)"
  export REPLICA_ROUTE53_ZONE_ID="$(layer1_output_raw route53_zone_id)"
  export REPLICA_ACM_CERT_ARN="$(layer1_output_raw acm_certificate_arn)"
  export REPLICA_ALB_GROUP_NAME="$(layer1_output_raw alb_group_name)"
  export REPLICA_WORKER_IRSA_ROLE_ARN="$(layer1_output_raw worker_irsa_role_arn)"
  export REPLICA_SERVER_REPOSITORY_URL="$(layer1_output_raw server_repository_url)"
  export REPLICA_WEB_REPOSITORY_URL="$(layer1_output_raw web_repository_url)"
  export REPLICA_WORKER_REPOSITORY_URL="$(layer1_output_raw worker_repository_url)"
  export REPLICA_CUSTOMER_APP_REPOSITORY_NAME="$(layer1_output_raw customer_app_repository_name)"
  export REPLICA_ALB_LOG_BUCKET="$(layer1_output_raw alb_log_bucket)"
  export REPLICA_ALB_LOG_PREFIX="$(layer1_output_raw alb_log_prefix)"
}

export_layer2_tf_vars() {
  export TF_VAR_aws_region="$REPLICA_AWS_REGION"
  export TF_VAR_cluster_name="$(layer1_output_raw cluster_name)"
  export TF_VAR_cluster_endpoint="$(layer1_output_raw cluster_endpoint)"
  export TF_VAR_cluster_certificate_authority_data="$(layer1_output_raw cluster_certificate_authority_data)"
  export TF_VAR_vpc_id="$(layer1_output_raw vpc_id)"
  export TF_VAR_alb_controller_role_arn="$(layer1_output_raw alb_controller_irsa_role_arn)"
  export TF_VAR_ebs_csi_role_arn="$(layer1_output_raw ebs_csi_irsa_role_arn)"
}

update_kubeconfig_for_replica() {
  aws eks update-kubeconfig \
    --region "$REPLICA_AWS_REGION" \
    --name "$(layer1_output_raw cluster_name)" \
    --alias "$(layer1_output_raw cluster_name)" >/dev/null
}

shared_alb_hostname() {
  namespace="${PLATFORM_NAMESPACE:-vibes-platform}"
  for ingress_name in "${PLATFORM_WEB_NAME:-vibes-web}" "${PLATFORM_SERVER_NAME:-vibes-server}"; do
    hostname="$(kubectl_retry -n "$namespace" get ingress "$ingress_name" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
    if [ -n "$hostname" ]; then
      printf '%s\n' "$hostname"
      return 0
    fi
  done

  return 1
}

wait_for_shared_alb_hostname() {
  attempts="${1:-60}"
  delay_seconds="${2:-5}"
  count=1

  while [ "$count" -le "$attempts" ]; do
    if hostname="$(shared_alb_hostname)"; then
      printf '%s\n' "$hostname"
      return 0
    fi

    sleep "$delay_seconds"
    count=$((count + 1))
  done

  return 1
}

dns_first_ipv4() {
  hostname="$1"
  node - <<'EOF' "$hostname"
const dns = require('dns');

async function resolveFirstIpv4(hostname) {
  try {
    const addresses = await dns.promises.resolve4(hostname);
    if (Array.isArray(addresses) && addresses.length > 0) return addresses[0];
  } catch {}

  const resolver = new dns.promises.Resolver();
  resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const addresses = await resolver.resolve4(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`no A records for ${hostname}`);
  }
  return addresses[0];
}

resolveFirstIpv4(process.argv[2])
  .then((address) => {
    process.stdout.write(`${address}\n`);
  })
  .catch(() => {
    process.exit(1);
  });
EOF
}

dns_hostname_resolves() {
  hostname="$1"
  dns_first_ipv4 "$hostname" >/dev/null 2>&1
}

wait_for_dns_hostname() {
  hostname="$1"
  attempts="${2:-60}"
  delay_seconds="${3:-5}"
  count=1

  while [ "$count" -le "$attempts" ]; do
    if dns_hostname_resolves "$hostname"; then
      return 0
    fi

    sleep "$delay_seconds"
    count=$((count + 1))
  done

  return 1
}
