#!/usr/bin/env sh
set -eu

if [ -z "${WEB_IMAGE:-}" ]; then
  echo "WEB_IMAGE is required" >&2
  exit 1
fi
if [ -z "${ACM_CERT_ARN:-}" ]; then
  echo "ACM_CERT_ARN is required to create the web ingress" >&2
  exit 1
fi
if [ -z "${WEB_HOST:-}" ]; then
  echo "WEB_HOST is required to create the web ingress" >&2
  exit 1
fi
if [ -z "${ROOT_HOST:-}" ]; then
  echo "ROOT_HOST is required to create the web ingress" >&2
  exit 1
fi

kubectl create namespace vibes-platform --dry-run=client -o yaml | kubectl apply -f -

envsubst < ./infra/k8s/web-deployment-template.yaml | kubectl apply -f -
kubectl apply -f ./infra/k8s/web-service.yaml
envsubst < ./infra/k8s/web-ingress.yaml | kubectl apply -f -
