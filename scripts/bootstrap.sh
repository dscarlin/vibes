#!/usr/bin/env sh
set -eu

if [ ! -f .env.local ] && [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Please edit before running." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..." >&2
  npm install
fi

ROOT="${VIBES_WORKDIR_ROOT:-$HOME/.vibes}"
NGINX_ROOT="${ROOT}/nginx"
NGINX_CONF_DIR="${NGINX_ROOT}/conf.d"
mkdir -p "$NGINX_CONF_DIR"
cp ./infra/dev/nginx.conf "${NGINX_ROOT}/nginx.conf"

if command -v podman-compose >/dev/null 2>&1; then
  podman-compose -f ./infra/dev/podman-compose.yml up -d
  podman exec vibes-nginx nginx -s reload >/dev/null 2>&1 || true
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f ./infra/dev/podman-compose.yml up -d
  docker exec vibes-nginx nginx -s reload >/dev/null 2>&1 || true
else
  echo "No podman-compose or docker-compose found. Skipping dev containers." >&2
fi

export RUN_MIGRATIONS=true

node server/src/index.js 2>&1 | sed -u 's/^/[server] /' &
SERVER_PID=$!
node worker/src/index.js 2>&1 | sed -u 's/^/[worker] /' &
WORKER_PID=$!
node web/src/index.js 2>&1 | sed -u 's/^/[web] /' &
WEB_PID=$!

cleanup() {
  echo "Stopping services..." >&2
  kill $SERVER_PID $WORKER_PID $WEB_PID >/dev/null 2>&1 || true
}

trap cleanup INT TERM

wait $SERVER_PID
