#!/usr/bin/env sh
set -eu

if [ -z "${SERVER_IMAGE:-}" ]; then
  echo "SERVER_IMAGE is required" >&2
  exit 1
fi
if [ -z "${ACM_CERT_ARN:-}" ]; then
  echo "ACM_CERT_ARN is required to create the server ingress" >&2
  exit 1
fi
if [ -z "${SERVER_HOST:-}" ]; then
  echo "SERVER_HOST is required to create the server ingress" >&2
  exit 1
fi

kubectl create namespace vibes-platform --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f ./infra/k8s/server-service-account.yaml
kubectl apply -f ./infra/k8s/server-rbac.yaml
envsubst < ./infra/k8s/server-deployment-template.yaml | kubectl apply -f -
kubectl apply -f ./infra/k8s/server-service.yaml
envsubst < ./infra/k8s/server-ingress.yaml | kubectl apply -f -
