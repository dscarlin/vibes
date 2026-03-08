#!/usr/bin/env sh
set -eu

ENV_FILE=".env"
if [ -f .env.local ]; then
  ENV_FILE=".env.local"
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "${ENV_FILE} not found" >&2
  exit 1
fi

# shellcheck disable=SC2046
export $(grep -v '^#' "$ENV_FILE" | xargs)

src="infra/k8s/worker-kustomization/kustomization.yaml"
out="infra/k8s/worker-kustomization/kustomization.generated.yaml"

cp "$src" "$out"

replace() {
  local file="$1"; shift
  for pair in "$@"; do
    key="${pair%%=*}"
    val="${pair#*=}"
    sed -i '' -e "s#${key}#${val}#g" "$file"
  done
}

replace "$out" \
  "REPLACE_WITH_PLATFORM_DB_URL=${DATABASE_URL}" \
  "REPLACE_WITH_CUSTOMER_DB_ADMIN_URL=${CUSTOMER_DB_ADMIN_URL}" \
  "REPLACE_WITH_CUSTOMER_DB_HOST=${CUSTOMER_DB_HOST}" \
  "REPLACE_WITH_CUSTOMER_DB_USER=${CUSTOMER_DB_USER}" \
  "REPLACE_WITH_CUSTOMER_DB_PASSWORD=${CUSTOMER_DB_PASSWORD}" \
  "REPLACE_WITH_REDIS_HOST=${REDIS_HOST}" \
  "REPLACE_WITH_STARTER_REPO_URL=${STARTER_REPO_URL}" \
  "REPLACE_WITH_GIT_TOKEN=${GIT_TOKEN}" \
  "REPLACE_WITH_SERVER_SOCKET_URL=${SERVER_SOCKET_URL}" \
  "REPLACE_WITH_AWS_REGION=${AWS_REGION}" \
  "REPLACE_WITH_AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID}" \
  "REPLACE_WITH_ECR_REPO=${ECR_REPO}" \
  "REPLACE_WITH_DOMAIN=${DOMAIN}" \
  "REPLACE_WITH_WORKER_IMAGE=${WORKER_IMAGE}"

echo "Generated $out" >&2
