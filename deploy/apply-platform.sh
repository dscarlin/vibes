#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd kubectl envsubst curl

source_env_file "$METADATA_ENV_FILE"
source_env_file "$IMAGES_ENV_FILE"

hash_paths() {
  if command -v shasum >/dev/null 2>&1; then
    cat "$@" | shasum -a 256 | awk '{print $1}'
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    cat "$@" | sha256sum | awk '{print $1}'
    return
  fi

  die "missing checksum tool: need shasum or sha256sum"
}

export ACM_CERT_ARN
export ALB_GROUP_NAME
export SERVER_HOST="$API_HOST"
export WEB_HOST="$APP_HOST"
export ROOT_HOST
export ALB_GROUP_ORDER_SERVER="${ALB_GROUP_ORDER_SERVER:-10}"
export ALB_GROUP_ORDER_WEB="${ALB_GROUP_ORDER_WEB:-20}"
export ALB_LOAD_BALANCER_ATTRIBUTES="access_logs.s3.enabled=true,access_logs.s3.bucket=${ALB_LOG_BUCKET},access_logs.s3.prefix=${ALB_LOG_PREFIX}"
export WORKER_IRSA_ROLE_ARN
export SERVER_IMAGE
export WEB_IMAGE
export WORKER_IMAGE
export SERVER_CONFIG_HASH="$(hash_paths "$SERVER_ENV_FILE" "$REPO_ROOT/rds-ca.pem")"
export WEB_CONFIG_HASH="$(hash_paths "$WEB_ENV_FILE")"
export WORKER_CONFIG_HASH="$(hash_paths "$WORKER_ENV_FILE" "$REPO_ROOT/rds-ca.pem")"

kubectl_retry create namespace vibes-platform --dry-run=client -o yaml | kubectl_retry apply -f - >/dev/null

kubectl_retry -n vibes-platform create secret generic vibes-server-env \
  --from-env-file="$SERVER_ENV_FILE" \
  --dry-run=client -o yaml | kubectl_retry apply -f -

kubectl_retry -n vibes-platform create secret generic vibes-web-env \
  --from-env-file="$WEB_ENV_FILE" \
  --dry-run=client -o yaml | kubectl_retry apply -f -

kubectl_retry -n vibes-platform create secret generic vibes-worker-env \
  --from-env-file="$WORKER_ENV_FILE" \
  --dry-run=client -o yaml | kubectl_retry apply -f -

kubectl_retry -n vibes-platform create secret generic rds-ca-bundle \
  --from-file=rds-ca.pem="$REPO_ROOT/rds-ca.pem" \
  --dry-run=client -o yaml | kubectl_retry apply -f -

kubectl_retry apply -f "$REPO_ROOT/deploy/k8s/platform/server-service-account.yaml"
kubectl_retry apply -f "$REPO_ROOT/deploy/k8s/platform/server-rbac.yaml"
envsubst <"$REPO_ROOT/deploy/k8s/platform/worker-service-account.yaml.tpl" | kubectl_retry apply -f -
kubectl_retry apply -f "$REPO_ROOT/deploy/k8s/platform/worker-rbac.yaml"
kubectl_retry apply -f "$REPO_ROOT/deploy/k8s/platform/redis.yaml"
kubectl_retry apply -f "$REPO_ROOT/deploy/k8s/platform/server-service.yaml"
kubectl_retry apply -f "$REPO_ROOT/deploy/k8s/platform/web-service.yaml"
envsubst <"$REPO_ROOT/deploy/k8s/platform/server-deployment.yaml.tpl" | kubectl_retry apply -f -
envsubst <"$REPO_ROOT/deploy/k8s/platform/web-deployment.yaml.tpl" | kubectl_retry apply -f -
envsubst <"$REPO_ROOT/deploy/k8s/platform/worker-deployment.yaml.tpl" | kubectl_retry apply -f -
envsubst <"$REPO_ROOT/deploy/k8s/platform/server-ingress.yaml.tpl" | kubectl_retry apply -f -
envsubst <"$REPO_ROOT/deploy/k8s/platform/web-ingress.yaml.tpl" | kubectl_retry apply -f -

kubectl_retry -n vibes-platform rollout status deploy/redis --timeout=5m
kubectl_retry -n vibes-platform rollout status deploy/vibes-server --timeout=10m
kubectl_retry -n vibes-platform rollout status deploy/vibes-web --timeout=10m
kubectl_retry -n vibes-platform rollout status deploy/vibes-worker --timeout=10m

"$REPO_ROOT/deploy/sync-base-dns.sh"

ALB_DNS_NAME="$(wait_for_shared_alb_hostname 60 5 || true)"
if [ -z "$ALB_DNS_NAME" ]; then
  die "shared ALB hostname not yet available from grouped replica ingresses"
fi

API_CONNECT_IP="$(dns_first_ipv4 "$API_HOST" || true)"
WEB_CONNECT_IP="$(dns_first_ipv4 "$APP_HOST" || true)"

if [ -z "$API_CONNECT_IP" ]; then
  die "failed to resolve an IPv4 address for ${API_HOST}"
fi

if [ -z "$WEB_CONNECT_IP" ]; then
  die "failed to resolve an IPv4 address for ${APP_HOST}"
fi

wait_for_http() {
  url="$1"
  connect_host="${2:-}"
  attempts="${3:-24}"
  delay_seconds="${4:-5}"
  request_host="$(printf '%s\n' "$url" | sed -E 's#https?://([^/:]+).*#\1#')"
  count=1
  while [ "$count" -le "$attempts" ]; do
    if [ -n "$connect_host" ]; then
      if curl --fail --silent --show-error --connect-to "${request_host}:443:${connect_host}:443" "$url" >/dev/null 2>&1; then
        return 0
      fi
    elif curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_seconds"
    count=$((count + 1))
  done
  return 1
}

wait_for_http "https://${API_HOST}/health" "$API_CONNECT_IP" 24 5
wait_for_http "https://${APP_HOST}" "$WEB_CONNECT_IP" 24 5

log "Replica platform workloads are healthy"
