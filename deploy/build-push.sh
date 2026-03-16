#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd aws docker git
source_env_file "$METADATA_ENV_FILE"

IMAGE_TAG="${REPLICA_IMAGE_TAG:-}"
if [ -z "$IMAGE_TAG" ]; then
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  if [ -n "$GIT_SHA" ] &&
    git -C "$REPO_ROOT" diff --quiet --ignore-submodules HEAD -- &&
    [ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]; then
    IMAGE_TAG="$GIT_SHA"
  elif [ -n "$GIT_SHA" ]; then
    IMAGE_TAG="${GIT_SHA}-dirty-$(date +%Y%m%d%H%M%S)"
  else
    IMAGE_TAG="$(date +%Y%m%d%H%M%S)"
  fi
fi

REGISTRY="$(printf '%s\n' "$SERVER_REPOSITORY_URL" | cut -d/ -f1)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

build_and_push() {
  repository_url="$1"
  dockerfile="$2"
  image_ref="${repository_url}:${IMAGE_TAG}"
  printf '[replica] Building %s\n' "$image_ref" >&2
  if docker buildx version >/dev/null 2>&1; then
    docker buildx build --platform linux/amd64 -t "$image_ref" -f "$dockerfile" --push "$REPO_ROOT"
  else
    docker build -t "$image_ref" -f "$dockerfile" "$REPO_ROOT"
    docker push "$image_ref"
  fi
}

build_and_push "$SERVER_REPOSITORY_URL" "$REPO_ROOT/server/Dockerfile"
SERVER_IMAGE="${SERVER_REPOSITORY_URL}:${IMAGE_TAG}"

build_and_push "$WEB_REPOSITORY_URL" "$REPO_ROOT/web/Dockerfile"
WEB_IMAGE="${WEB_REPOSITORY_URL}:${IMAGE_TAG}"

build_and_push "$WORKER_REPOSITORY_URL" "$REPO_ROOT/worker/Dockerfile"
WORKER_IMAGE="${WORKER_REPOSITORY_URL}:${IMAGE_TAG}"

cat >"$IMAGES_ENV_FILE" <<EOF
SERVER_IMAGE=$SERVER_IMAGE
WEB_IMAGE=$WEB_IMAGE
WORKER_IMAGE=$WORKER_IMAGE
IMAGE_TAG=$IMAGE_TAG
EOF

log "Wrote $IMAGES_ENV_FILE"
