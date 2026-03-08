#!/usr/bin/env sh
set -eu
if [ -z "${1:-}" ]; then
  echo "usage: empty-db.sh <namespace>" >&2
  exit 1
fi
NAMESPACE="$1"
DEPLOY="vibes-postgres"
# Drop and recreate the database inside the postgres container
kubectl -n "$NAMESPACE" exec deploy/$DEPLOY -- psql -U postgres -c "drop database if exists vibes; create database vibes;"
