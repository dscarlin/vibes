#!/usr/bin/env sh
set -eu
if [ -z "${SNAPSHOT_PATH:-}" ]; then
  echo "SNAPSHOT_PATH required" >&2
  exit 1
fi
if [ -z "${ENV_FILE:-}" ]; then
  echo "ENV_FILE required" >&2
  exit 1
fi
if [ -z "${PROJECT_ID:-}" ]; then
  echo "PROJECT_ID required" >&2
  exit 1
fi
if [ -z "${ENVIRONMENT:-}" ]; then
  echo "ENVIRONMENT required" >&2
  exit 1
fi
ROOT="${VIBES_WORKDIR_ROOT:-$HOME/.vibes}"
WORKDIR="${ROOT}/deploy-${PROJECT_ID}-${ENVIRONMENT}"
mkdir -p "$ROOT"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
tar -xzf "$SNAPSHOT_PATH" -C "$WORKDIR"

strip_env_conflicts() {
  env_file="$1"
  workdir="$2"
  if [ ! -f "$env_file" ]; then
    return
  fi
  find "$workdir" -maxdepth 3 -name '.env*' -type f \
    -not -name '*.example' -not -name '*.sample' -exec sh -c '
      env_file="$1"
      shift
      for file in "$@"; do
        awk -F= '"'"'
          FNR==NR {
            key=$1;
            sub(/^[[:space:]]*export[[:space:]]+/, "", key);
            sub(/[[:space:]]+$/, "", key);
            if (key != "" && key !~ /^#/) keys[key]=1;
            next
          }
          {
            line=$0;
            sub(/^[[:space:]]*export[[:space:]]+/, "", line);
            split(line, parts, "=");
            key=parts[1];
            sub(/[[:space:]]+$/, "", key);
            if (key=="" || key ~ /^#/) { print $0; next }
            if (!(key in keys)) print $0
          }
        '"'"' "$env_file" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
      done
    ' sh "$env_file" {} +
}

strip_env_conflicts "$ENV_FILE" "$WORKDIR"
if [ -z "${APP_PORT:-}" ]; then
  APP_PORT="$(awk -F= '$1=="PORT"{print $2}' "$ENV_FILE" | tail -n 1)"
fi
# Default to starter app port if not provided.
APP_PORT="${APP_PORT:-3000}"
if [ -z "${APP_HOST:-}" ]; then
  APP_HOST="$(awk -F= '$1=="DOMAIN"{print $2}' "$ENV_FILE" | tail -n 1)"
fi
if [ -n "${APP_HOST:-}" ]; then
  APP_HOST="${APP_HOST%%:*}"
fi
NGINX_ROOT="${ROOT}/nginx"
NGINX_CONF_DIR="${NGINX_ROOT}/conf.d"
mkdir -p "$NGINX_CONF_DIR"
cp ./infra/dev/nginx.conf "${NGINX_ROOT}/nginx.conf"
SHORT_ID="${PROJECT_SHORT_ID:-$PROJECT_ID}"
CONTAINER_NAME="vibes-app-${SHORT_ID}-${ENVIRONMENT}"
INSTALL_NAME="vibes-install-${SHORT_ID}-${ENVIRONMENT}"
# Stop existing container if running
podman rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
# Install dependencies in an isolated container before exposing traffic
podman rm -f "$INSTALL_NAME" >/dev/null 2>&1 || true
podman run --name "$INSTALL_NAME" --rm \
  --network vibes-net \
  --env-file "$ENV_FILE" \
  ${DATABASE_URL:+-e} ${DATABASE_URL:+DATABASE_URL=$DATABASE_URL} \
  -v "$WORKDIR":/app \
  -w /app \
  node:20 \
  sh -lc "set -eu; \
    if [ -f package-lock.json ]; then npm ci; elif [ -f yarn.lock ]; then yarn install; elif [ -f pnpm-lock.yaml ]; then npm i -g pnpm && pnpm i; elif [ -f package.json ]; then npm install; fi; \
    if [ -f scripts/start-all.js ] && [ -f server/package.json ] && [ -f web/package.json ]; then \
      if [ -f server/package-lock.json ]; then (cd server && npm ci); elif [ -f server/yarn.lock ]; then (cd server && yarn install); else (cd server && npm install); fi; \
      if [ -f web/package-lock.json ]; then (cd web && npm ci); elif [ -f web/yarn.lock ]; then (cd web && yarn install); else (cd web && npm install); fi; \
      (cd server && npm run prisma:generate --if-present && npm run build --if-present); \
      (cd web && npm run build --if-present); \
    fi"

RUNTIME_COMMAND="${START_COMMAND:-}"
if [ -z "$RUNTIME_COMMAND" ]; then
  if [ -f "$WORKDIR/scripts/start-all.js" ] && [ -f "$WORKDIR/server/dist/index.js" ]; then
    RUNTIME_COMMAND="node server/dist/index.js"
  elif [ -f "$WORKDIR/scripts/start-all.js" ] && [ -f "$WORKDIR/server/index.js" ]; then
    RUNTIME_COMMAND="node server/index.js"
  else
    RUNTIME_COMMAND="npm start"
  fi
fi
echo "dev deploy runtime command: $RUNTIME_COMMAND"

# Run app container using repo snapshot and env file
podman run -d --name "$CONTAINER_NAME" \
  --network vibes-net \
  --env-file "$ENV_FILE" \
  ${DATABASE_URL:+-e} ${DATABASE_URL:+DATABASE_URL=$DATABASE_URL} \
  -v "$WORKDIR":/app \
  -w /app \
  node:20 \
  sh -lc "$RUNTIME_COMMAND"

# Update nginx routing for host -> container
if [ -n "${APP_HOST:-}" ]; then
  APP_HOSTS="${APP_HOST}"
  APP_SUBDOMAIN="${APP_HOST%%.*}"
  if [ -n "${APP_SUBDOMAIN:-}" ]; then
    APP_HOSTS="${APP_HOSTS} ${APP_SUBDOMAIN}.localhost ${APP_SUBDOMAIN}.lvh.me"
    APP_HOSTS="${APP_HOSTS} ${APP_SUBDOMAIN}.10.0.2.2.nip.io 10.0.2.2"
    if [ -n "${APP_LAN_IP:-}" ]; then
      APP_HOSTS="${APP_HOSTS} ${APP_SUBDOMAIN}.${APP_LAN_IP}.nip.io"
    fi
  fi
  cat > "${NGINX_CONF_DIR}/${PROJECT_ID}-${ENVIRONMENT}.conf" <<EOF_NGX
server {
  listen 80;
  server_name ${APP_HOSTS};
  location / {
    set \$upstream ${CONTAINER_NAME}:${APP_PORT};
    proxy_pass http://\$upstream;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  }
}
EOF_NGX
  podman exec vibes-nginx nginx -s reload >/dev/null 2>&1 || true
fi
