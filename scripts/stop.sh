#!/usr/bin/env sh
set -eu
if command -v podman-compose >/dev/null 2>&1; then
  podman-compose -f ./infra/dev/podman-compose.yml down
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f ./infra/dev/podman-compose.yml down
else
  echo "No podman-compose or docker-compose found. Nothing to stop." >&2
fi
