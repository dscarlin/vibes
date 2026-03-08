#!/usr/bin/env sh
set -eu

NAMESPACE="${NAMESPACE:-vibes-platform}"
SECRET_NAME="${SECRET_NAME:-vibes-worker-env}"
ENV_FILE="${WORKER_ENV_FILE:-}"

if [ -z "$ENV_FILE" ]; then
  echo "WORKER_ENV_FILE is required (path to env file)" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-env-file="$ENV_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Applied secret ${SECRET_NAME} in namespace ${NAMESPACE}"
