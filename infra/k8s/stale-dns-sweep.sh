#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  DOMAIN=<app-domain> ./infra/k8s/stale-dns-sweep.sh dry-run
  DOMAIN=<app-domain> ./infra/k8s/stale-dns-sweep.sh apply

Environment variables:
  DOMAIN                         Required. Root app domain (example: vibesplatform.ai)
  ROUTE53_HOSTED_ZONE_ID         Optional. If unset, script resolves hosted zone from DOMAIN.
  AWS_BIN                        Optional. AWS CLI binary (default: aws).
  KUBECTL_BIN                    Optional. kubectl binary (default: kubectl).
  KEEP_HOSTS                     Optional. Comma-separated hostnames to always keep.
  INCLUDE_NON_PROJECT_RECORDS    Optional. true|false (default false).

Notes:
  - Script compares Route53 A records against active ingress hosts from the cluster.
  - By default it only considers hostnames matching project host patterns:
      <slug>-<shortid>.<domain>
      <slug>-development-<shortid>.<domain>
      <slug>-testing-<shortid>.<domain>
EOF
}

MODE="${1:-dry-run}"
if [[ "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$MODE" != "dry-run" && "$MODE" != "apply" ]]; then
  echo "Invalid mode: $MODE" >&2
  usage
  exit 1
fi

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "DOMAIN is required" >&2
  usage
  exit 1
fi
DOMAIN="${DOMAIN%.}"
DOMAIN_DOT="${DOMAIN}."

AWS_BIN="${AWS_BIN:-aws}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID:-}"
KEEP_HOSTS="${KEEP_HOSTS:-}"
INCLUDE_NON_PROJECT_RECORDS="$(echo "${INCLUDE_NON_PROJECT_RECORDS:-false}" | tr '[:upper:]' '[:lower:]')"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
}

require_cmd "$AWS_BIN"
require_cmd "$KUBECTL_BIN"
require_cmd jq

if [[ -z "$ROUTE53_HOSTED_ZONE_ID" ]]; then
  ROUTE53_HOSTED_ZONE_ID="$("$AWS_BIN" route53 list-hosted-zones-by-name \
    --dns-name "$DOMAIN" \
    --max-items 1 \
    --query 'HostedZones[0].Id' \
    --output text)"
  ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID#/hostedzone/}"
fi

if [[ -z "$ROUTE53_HOSTED_ZONE_ID" || "$ROUTE53_HOSTED_ZONE_ID" == "None" ]]; then
  echo "Could not resolve Route53 hosted zone for DOMAIN=${DOMAIN}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d /tmp/vibes-stale-dns-XXXXXX)"
active_hosts_file="${tmp_dir}/active-hosts.txt"
all_records_file="${tmp_dir}/all-records.json"
stale_records_file="${tmp_dir}/stale-records.ndjson"
touch "$active_hosts_file" "$stale_records_file"
trap 'rm -rf "$tmp_dir"' EXIT

host_looks_like_project() {
  local host="$1"
  if [[ "$host" =~ ^[a-z0-9-]+-(development|testing)-[a-z0-9]{6}\.${DOMAIN}$ ]]; then
    return 0
  fi
  if [[ "$host" =~ ^[a-z0-9-]+-[a-z0-9]{6}\.${DOMAIN}$ ]]; then
    return 0
  fi
  return 1
}

# Active ingress hosts in cluster.
"$KUBECTL_BIN" get ingress -A -o json \
  | jq -r '.items[]?.spec.rules[]?.host // empty' \
  | tr '[:upper:]' '[:lower:]' \
  | sed '/^[[:space:]]*$/d' \
  | sort -u > "$active_hosts_file"

# Optional explicit keep-list.
if [[ -n "$KEEP_HOSTS" ]]; then
  printf '%s\n' "$KEEP_HOSTS" \
    | tr ',' '\n' \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | sed '/^[[:space:]]*$/d' >> "$active_hosts_file"
  sort -u -o "$active_hosts_file" "$active_hosts_file"
fi

"$AWS_BIN" route53 list-resource-record-sets \
  --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
  --max-items 10000 \
  --output json > "$all_records_file"

jq -c --arg domain_dot "$DOMAIN_DOT" '
  .ResourceRecordSets[]
  | select(.Type == "A")
  | . as $record
  | ($record.Name | ascii_downcase) as $name
  | select($name | endswith($domain_dot))
  | select($name != $domain_dot)
  | select(($name | startswith("*.")) | not)
  | {name: $name, record: $record}
' "$all_records_file" | while IFS= read -r entry; do
  name="$(echo "$entry" | jq -r '.name')"
  host="${name%.}"
  if grep -Fxq "$host" "$active_hosts_file"; then
    continue
  fi
  if [[ "$INCLUDE_NON_PROJECT_RECORDS" != "true" ]] && ! host_looks_like_project "$host"; then
    continue
  fi
  echo "$entry" >> "$stale_records_file"
done

active_count="$(wc -l < "$active_hosts_file" | tr -d ' ')"
stale_count="$(wc -l < "$stale_records_file" | tr -d ' ')"

echo "Route53 zone: ${ROUTE53_HOSTED_ZONE_ID}"
echo "Domain: ${DOMAIN}"
echo "Active ingress hosts: ${active_count}"
echo "Stale candidate records: ${stale_count}"

if [[ "$stale_count" -eq 0 ]]; then
  echo "No stale records detected."
  exit 0
fi

echo
echo "Candidates:"
while IFS= read -r entry; do
  name="$(echo "$entry" | jq -r '.name')"
  target="$(echo "$entry" | jq -r '.record.AliasTarget.DNSName // (.record.ResourceRecords | map(.Value) | join(",")) // ""')"
  echo "  - ${name%.} -> ${target}"
done < "$stale_records_file"

if [[ "$MODE" == "dry-run" ]]; then
  echo
  echo "Dry-run complete. Re-run with 'apply' to delete these records."
  exit 0
fi

echo
echo "Applying deletions..."
deleted=0
while IFS= read -r entry; do
  name="$(echo "$entry" | jq -r '.name')"
  record_json="$(echo "$entry" | jq '.record')"
  change_file="$(mktemp "${tmp_dir}/route53-change-XXXXXX.json")"
  jq -n --argjson record "$record_json" --arg host "${name%.}" '{
    Comment: ("Delete stale project record " + $host),
    Changes: [
      {
        Action: "DELETE",
        ResourceRecordSet: $record
      }
    ]
  }' > "$change_file"
  "$AWS_BIN" route53 change-resource-record-sets \
    --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
    --change-batch "file://${change_file}" >/dev/null
  echo "  deleted ${name%.}"
  deleted=$((deleted + 1))
done < "$stale_records_file"

echo
echo "Deleted ${deleted} stale Route53 record(s)."
