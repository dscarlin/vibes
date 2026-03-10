#!/usr/bin/env sh
set -eu

# Ensure standard system paths are present for exec plugins (aws) and core utilities.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
if [ -z "${PROJECT_ID:-}" ] || [ -z "${ENVIRONMENT:-}" ]; then
  echo "PROJECT_ID and ENVIRONMENT required" >&2
  exit 1
fi
if [ -z "${AWS_REGION:-}" ] || [ -z "${AWS_ACCOUNT_ID:-}" ] || [ -z "${ECR_REPO:-}" ]; then
  echo "AWS_REGION, AWS_ACCOUNT_ID, ECR_REPO required" >&2
  exit 1
fi

NAMESPACE="vibes-${ENVIRONMENT}"
APP_NAME="vibes-app-${PROJECT_ID}"

kubectl -n "$NAMESPACE" delete ingress "$APP_NAME" --ignore-not-found
kubectl -n "$NAMESPACE" delete service "$APP_NAME" --ignore-not-found
kubectl -n "$NAMESPACE" delete deployment "$APP_NAME" --ignore-not-found
kubectl -n "$NAMESPACE" delete pod "$APP_NAME" --ignore-not-found
kubectl -n "$NAMESPACE" delete pod -l app="$APP_NAME" --ignore-not-found --wait=false >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete secret "$APP_NAME-env" --ignore-not-found

DELETE_ECR_IMAGES="${DELETE_ECR_IMAGES:-true}"
if [ "$DELETE_ECR_IMAGES" = "true" ]; then
  REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  PREFIX="${PROJECT_ID}-${ENVIRONMENT}-"
  IMAGE_IDS=$(aws ecr list-images --repository-name "$ECR_REPO" --region "$AWS_REGION" \
    --query "imageIds[?imageTag != null && starts_with(imageTag, \`${PREFIX}\`)]" --output json)
  if [ "$IMAGE_IDS" != "[]" ]; then
    aws ecr batch-delete-image --repository-name "$ECR_REPO" --region "$AWS_REGION" --image-ids "$IMAGE_IDS" >/dev/null
  fi
fi

AUTO_DNS="${AUTO_DNS:-}"
if [ -n "$AUTO_DNS" ] && [ "$AUTO_DNS" != "false" ]; then
  if [ -z "${APP_HOST:-}" ]; then
    echo "AUTO_DNS enabled but APP_HOST not set; skipping DNS delete" >&2
    exit 0
  fi
  AWS_BIN="${AWS_BIN:-aws}"
  if [ -z "$AWS_BIN" ]; then
    echo "AUTO_DNS enabled but aws CLI not available; skipping DNS delete" >&2
    exit 0
  fi
  ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID:-}"
  ROUTE53_DOMAIN="${ROUTE53_DOMAIN:-${APP_DOMAIN:-${DOMAIN:-}}}"
  if [ -z "$ROUTE53_DOMAIN" ] && [ -n "${APP_HOST:-}" ]; then
    ROUTE53_DOMAIN="${APP_HOST#*.}"
  fi
  ROUTE53_DOMAIN="${ROUTE53_DOMAIN%.}"
  if [ -z "$ROUTE53_HOSTED_ZONE_ID" ]; then
    if [ -z "$ROUTE53_DOMAIN" ]; then
      echo "AUTO_DNS enabled but ROUTE53_DOMAIN/APP_DOMAIN/DOMAIN not set; skipping DNS delete" >&2
      exit 0
    fi
    ROUTE53_HOSTED_ZONE_ID="$("$AWS_BIN" route53 list-hosted-zones-by-name --dns-name "$ROUTE53_DOMAIN" --max-items 1 --query 'HostedZones[0].Id' --output text)"
    ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID#/hostedzone/}"
  fi
  if [ -z "$ROUTE53_HOSTED_ZONE_ID" ] || [ "$ROUTE53_HOSTED_ZONE_ID" = "None" ]; then
    echo "AUTO_DNS could not resolve Route53 hosted zone for ${ROUTE53_DOMAIN}; skipping DNS delete" >&2
    exit 0
  fi

  RECORD_JSON="$("$AWS_BIN" route53 list-resource-record-sets \
    --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
    --start-record-name "${APP_HOST}." \
    --start-record-type A \
    --max-items 1 \
    --query 'ResourceRecordSets[0]' \
    --output json)"

  if [ -z "$RECORD_JSON" ] || [ "$RECORD_JSON" = "null" ]; then
    echo "AUTO_DNS could not find record for ${APP_HOST}; skipping DNS delete" >&2
    exit 0
  fi

  # Ensure the record we fetched matches the hostname and type.
  MATCH_NAME="$("$AWS_BIN" route53 list-resource-record-sets \
    --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
    --start-record-name "${APP_HOST}." \
    --start-record-type A \
    --max-items 1 \
    --query 'ResourceRecordSets[0].Name' \
    --output text)"
  MATCH_TYPE="$("$AWS_BIN" route53 list-resource-record-sets \
    --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
    --start-record-name "${APP_HOST}." \
    --start-record-type A \
    --max-items 1 \
    --query 'ResourceRecordSets[0].Type' \
    --output text)"
  if [ "$MATCH_NAME" != "${APP_HOST}." ] || [ "$MATCH_TYPE" != "A" ]; then
    echo "AUTO_DNS record mismatch for ${APP_HOST}; skipping DNS delete" >&2
    exit 0
  fi

  CHANGE_JSON="$(mktemp /tmp/route53-delete-XXXXXX.json)"
  cat > "$CHANGE_JSON" <<EOF
{
  "Comment": "Delete ${APP_HOST} record",
  "Changes": [
    {
      "Action": "DELETE",
      "ResourceRecordSet": ${RECORD_JSON}
    }
  ]
}
EOF
  "$AWS_BIN" route53 change-resource-record-sets --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" --change-batch "file://$CHANGE_JSON" >/dev/null
  echo "AUTO_DNS deleted: ${APP_HOST} (zone ${ROUTE53_HOSTED_ZONE_ID})"
fi
