#!/usr/bin/env sh
set -eu
kubectl create namespace cert-manager >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --set installCRDs=true
