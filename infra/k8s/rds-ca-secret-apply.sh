#!/usr/bin/env sh
set -eu

NAMESPACE="${NAMESPACE:-vibes-platform}"
SECRET_NAME="${SECRET_NAME:-rds-ca-bundle}"
CA_FILE="${RDS_CA_FILE:-}"

if [ -z "$CA_FILE" ]; then
  echo "RDS_CA_FILE is required (path to AWS RDS CA bundle pem)" >&2
  exit 1
fi
if [ ! -f "$CA_FILE" ]; then
  echo "CA file not found: $CA_FILE" >&2
  exit 1
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-file=rds-ca.pem="$CA_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Applied secret ${SECRET_NAME} in namespace ${NAMESPACE}"
