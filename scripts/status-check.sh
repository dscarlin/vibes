#!/usr/bin/env sh
set -eu

NAMESPACE_PLATFORM="${NAMESPACE_PLATFORM:-vibes-platform}"
NAMESPACE_DEV="${NAMESPACE_DEV:-vibes-development}"
NAMESPACE_TEST="${NAMESPACE_TEST:-vibes-testing}"
NAMESPACE_PROD="${NAMESPACE_PROD:-vibes-production}"

echo "== Platform =="
kubectl -n "$NAMESPACE_PLATFORM" get deploy,pods -o wide

echo "== Development =="
kubectl -n "$NAMESPACE_DEV" get deploy,pods -o wide || true

echo "== Testing =="
kubectl -n "$NAMESPACE_TEST" get deploy,pods -o wide || true

echo "== Production =="
kubectl -n "$NAMESPACE_PROD" get deploy,pods -o wide || true
