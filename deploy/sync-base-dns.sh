#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd aws kubectl node
source_env_file "$METADATA_ENV_FILE"

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
cat >"$CHANGE_BATCH" <<EOF
{
  "Comment": "Upsert replica base aliases",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${ROOT_HOST}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE_ID}",
          "DNSName": "${ALB_DNS_NAME}",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${APP_HOST}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE_ID}",
          "DNSName": "${ALB_DNS_NAME}",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${API_HOST}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE_ID}",
          "DNSName": "${ALB_DNS_NAME}",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "*.${ROOT_HOST}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE_ID}",
          "DNSName": "${ALB_DNS_NAME}",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
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

log "Replica base DNS aliases updated, including wildcard project routing"
