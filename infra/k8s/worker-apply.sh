#!/usr/bin/env sh
set -eu
if [ -z "${WORKER_IMAGE:-}" ]; then
  echo "WORKER_IMAGE is required" >&2
  exit 1
fi

kubectl create namespace vibes-platform --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f ./infra/k8s/worker-service-account.yaml
kubectl apply -f ./infra/k8s/worker-rbac.yaml

envsubst < ./infra/k8s/worker-deployment-template.yaml | kubectl apply -f -
