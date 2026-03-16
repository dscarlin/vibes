#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd aws kubectl node
source_env_file "$METADATA_ENV_FILE"

PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-vibes-platform}"
PROJECT_WILDCARD_HOSTS="${PROJECT_WILDCARD_HOSTS:-${ROOT_HOST:-}}"

ALB_DNS_NAME="$(wait_for_shared_alb_hostname 60 5 || true)"
if [ -z "$ALB_DNS_NAME" ]; then
  die "shared ALB hostname not yet available from grouped replica ingresses"
fi

ALB_ZONE_ID="$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
  --query "LoadBalancers[?DNSName=='${ALB_DNS_NAME}'].CanonicalHostedZoneId" \
  --output text)"
if [ -z "$ALB_ZONE_ID" ] || [ "$ALB_ZONE_ID" = "None" ]; then
  die "failed to resolve ALB hosted zone id for $ALB_DNS_NAME"
fi

log "Waiting for shared ALB DNS hostname to resolve"
if ! wait_for_dns_hostname "$ALB_DNS_NAME" 60 5; then
  die "shared ALB hostname did not resolve in time: $ALB_DNS_NAME"
fi

CHANGE_BATCH="$(mktemp)"
ALB_DNS_NAME="$ALB_DNS_NAME" \
ALB_ZONE_ID="$ALB_ZONE_ID" \
ROOT_HOST="$ROOT_HOST" \
APP_HOST="$APP_HOST" \
API_HOST="$API_HOST" \
PROJECT_WILDCARD_HOSTS="$PROJECT_WILDCARD_HOSTS" \
node >"$CHANGE_BATCH" <<'EOF'
const hosts = [process.env.ROOT_HOST, process.env.APP_HOST, process.env.API_HOST]
  .map((value) => String(value || '').trim())
  .filter(Boolean);
const wildcardHosts = String(process.env.PROJECT_WILDCARD_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const aliasTarget = {
  HostedZoneId: String(process.env.ALB_ZONE_ID || '').trim(),
  DNSName: String(process.env.ALB_DNS_NAME || '').trim(),
  EvaluateTargetHealth: false
};
const changes = [];
for (const host of hosts) {
  changes.push({
    Action: 'UPSERT',
    ResourceRecordSet: {
      Name: host,
      Type: 'A',
      AliasTarget: aliasTarget
    }
  });
}
for (const host of wildcardHosts) {
  changes.push({
    Action: 'UPSERT',
    ResourceRecordSet: {
      Name: `*.${host}`,
      Type: 'A',
      AliasTarget: aliasTarget
    }
  });
}
process.stdout.write(`${JSON.stringify({ Comment: 'Upsert replica base aliases', Changes: changes }, null, 2)}\n`);
EOF

aws route53 change-resource-record-sets \
  --hosted-zone-id "$ROUTE53_ZONE_ID" \
  --change-batch "file://$CHANGE_BATCH" >/dev/null

rm -f "$CHANGE_BATCH"

for host in "$APP_HOST" "$API_HOST"; do
  log "Waiting for ${host} to resolve"
  if ! wait_for_dns_hostname "$host" 60 5; then
    die "replica base host did not resolve in time: $host"
  fi
done

log "Waiting for ${ROOT_HOST} to resolve"
if ! wait_for_dns_hostname "$ROOT_HOST" 60 5; then
  log "root host ${ROOT_HOST} is still not resolvable on the local resolver; continuing because app/api hosts are ready"
fi

log "Replica base DNS aliases updated, including wildcard project routing for ${PROJECT_WILDCARD_HOSTS}"
