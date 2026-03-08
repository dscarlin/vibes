#!/usr/bin/env sh
set -eu
# Install cert-manager via Helm
./infra/k8s/cert-manager-helm.sh
# Apply Route53 secret + DNS01 issuer
kubectl apply -f ./infra/k8s/route53-credentials-secret.yaml
kubectl apply -f ./infra/k8s/cluster-issuer-dns01.yaml
# Apply wildcard certificate (uses DNS01 issuer)
kubectl apply -f ./infra/k8s/wildcard-certificate.yaml
