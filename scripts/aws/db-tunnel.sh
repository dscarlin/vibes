#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
SERVER_ENV_FILE="${SERVER_ENV_FILE:-./.env.server}"
DB_TUNNEL_LOCAL_PORT="${DB_TUNNEL_LOCAL_PORT:-15432}"
DB_TUNNEL_REMOTE_HOST="${DB_TUNNEL_REMOTE_HOST:-}"
DB_TUNNEL_REMOTE_PORT="${DB_TUNNEL_REMOTE_PORT:-}"
DB_TUNNEL_TARGET="${DB_TUNNEL_TARGET:-}"
DB_TUNNEL_DRY_RUN="$(echo "${DB_TUNNEL_DRY_RUN:-false}" | tr '[:upper:]' '[:lower:]')"

if [[ -z "${DATABASE_URL:-}" ]] && [[ -f "$SERVER_ENV_FILE" ]]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$SERVER_ENV_FILE" | sed -n '1p')"
  DATABASE_URL="${DATABASE_URL%\"}"
  DATABASE_URL="${DATABASE_URL#\"}"
  DATABASE_URL="${DATABASE_URL%\'}"
  DATABASE_URL="${DATABASE_URL#\'}"
fi

if [[ -z "$DB_TUNNEL_REMOTE_HOST" ]] && [[ -n "${DATABASE_URL:-}" ]]; then
  parsed_host_port="$(
    DATABASE_URL="$DATABASE_URL" node -e '
      const u = new URL(process.env.DATABASE_URL);
      process.stdout.write(`${u.hostname}\n${u.port || "5432"}`);
    '
  )"
  DB_TUNNEL_REMOTE_HOST="$(printf '%s\n' "$parsed_host_port" | sed -n '1p')"
  if [[ -z "$DB_TUNNEL_REMOTE_PORT" ]]; then
    DB_TUNNEL_REMOTE_PORT="$(printf '%s\n' "$parsed_host_port" | sed -n '2p')"
  fi
fi

DB_TUNNEL_REMOTE_PORT="${DB_TUNNEL_REMOTE_PORT:-5432}"

if [[ -z "$DB_TUNNEL_REMOTE_HOST" ]]; then
  echo "DB_TUNNEL_REMOTE_HOST is required (or provide DATABASE_URL in $SERVER_ENV_FILE)." >&2
  exit 1
fi

if [[ -z "$DB_TUNNEL_TARGET" ]]; then
  db_vpc_id="$(
    aws rds describe-db-instances \
      --region "$AWS_REGION" \
      --query "DBInstances[?Endpoint.Address=='$DB_TUNNEL_REMOTE_HOST'].DBSubnetGroup.VpcId | [0]" \
      --output text 2>/dev/null || true
  )"

  if [[ -n "$db_vpc_id" ]] && [[ "$db_vpc_id" != "None" ]]; then
    online_instances="$(
      aws ssm describe-instance-information \
        --region "$AWS_REGION" \
        --query "InstanceInformationList[?PingStatus=='Online'].InstanceId" \
        --output text | tr '\t' '\n' | sed '/^$/d'
    )"
    while IFS= read -r instance_id; do
      [[ -z "$instance_id" ]] && continue
      instance_vpc_id="$(
        aws ec2 describe-instances \
          --region "$AWS_REGION" \
          --instance-ids "$instance_id" \
          --query "Reservations[0].Instances[0].VpcId" \
          --output text 2>/dev/null || true
      )"
      if [[ "$instance_vpc_id" == "$db_vpc_id" ]]; then
        DB_TUNNEL_TARGET="$instance_id"
        break
      fi
    done <<< "$online_instances"
  fi
fi

if [[ -z "$DB_TUNNEL_TARGET" ]]; then
  DB_TUNNEL_TARGET="$(
    aws ssm describe-instance-information \
      --region "$AWS_REGION" \
      --query "InstanceInformationList[?PingStatus=='Online'].InstanceId | [0]" \
      --output text
  )"
fi

if [[ -z "$DB_TUNNEL_TARGET" ]] || [[ "$DB_TUNNEL_TARGET" == "None" ]]; then
  echo "No online SSM managed instance found. Set DB_TUNNEL_TARGET=<instance-id> and retry." >&2
  exit 1
fi

echo "Starting SSM DB tunnel"
echo "  AWS region:      $AWS_REGION"
echo "  target instance: $DB_TUNNEL_TARGET"
echo "  remote host:     $DB_TUNNEL_REMOTE_HOST:$DB_TUNNEL_REMOTE_PORT"
echo "  local port:      127.0.0.1:$DB_TUNNEL_LOCAL_PORT"
echo

if [[ "$DB_TUNNEL_DRY_RUN" == "true" ]]; then
  echo "Dry run enabled; tunnel not started."
  exit 0
fi

aws ssm start-session \
  --region "$AWS_REGION" \
  --target "$DB_TUNNEL_TARGET" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_TUNNEL_REMOTE_HOST\"],\"portNumber\":[\"$DB_TUNNEL_REMOTE_PORT\"],\"localPortNumber\":[\"$DB_TUNNEL_LOCAL_PORT\"]}"
