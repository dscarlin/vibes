#!/usr/bin/env sh
set -eu
if [ -z "${PROJECT_ID:-}" ] || [ -z "${ENVIRONMENT:-}" ]; then
  echo "PROJECT_ID and ENVIRONMENT required" >&2
  exit 1
fi
PROJECT_SHORT_ID="${PROJECT_SHORT_ID:-$PROJECT_ID}"
ROOT="${VIBES_WORKDIR_ROOT:-$HOME/.vibes}"
WORKDIR="${ROOT}/deploy-${PROJECT_ID}-${ENVIRONMENT}"
NGINX_CONF_DIR="${ROOT}/nginx/conf.d"

podman rm -f "vibes-app-${PROJECT_SHORT_ID}-${ENVIRONMENT}" >/dev/null 2>&1 || true
rm -f "${NGINX_CONF_DIR}/${PROJECT_ID}-${ENVIRONMENT}.conf"
rm -f "${NGINX_CONF_DIR}/${PROJECT_SHORT_ID}-${ENVIRONMENT}.conf"
rm -rf "$WORKDIR"
podman exec vibes-nginx nginx -s reload >/dev/null 2>&1 || true
