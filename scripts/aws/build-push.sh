#!/usr/bin/env sh
set -eu

AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:-}"
TAG="${TAG:-}"

if [ -z "$ACCOUNT_ID" ]; then
  echo "ACCOUNT_ID is required" >&2
  exit 1
fi

REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
TAG_FILE="${TAG_FILE:-.last-build-tag}"
IMAGE_FILE="${IMAGE_FILE:-.last-build-images}"

if [ -z "$TAG" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    TAG="$(git rev-parse --short HEAD)"
    DIRTY_STATUS="$(
      git status --porcelain --untracked-files=all 2>/dev/null | \
        grep -vE '^[ MARCUD?!][ MARCUD?!] (\.last-build-tag|\.last-build-images)$' || true
    )"
    if [ -n "$DIRTY_STATUS" ]; then
      TAG="${TAG}-dirty-$(date +%Y%m%d%H%M%S)"
      echo "Git working tree has local changes; using unique tag: ${TAG}"
    fi
  else
    TAG="$(date +%Y%m%d%H%M%S)"
  fi
fi

echo "Using tag: ${TAG}"
echo "Registry: ${REGISTRY}"
printf '%s\n' "$TAG" > "$TAG_FILE"
printf '%s\n' "REGISTRY=${REGISTRY}" "TAG=${TAG}" > "$IMAGE_FILE"

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$REGISTRY"

build_and_push () {
  name="$1"
  dockerfile="$2"
  echo "Building ${name}..."
  docker buildx build --platform linux/amd64 -t "${REGISTRY}/${name}:${TAG}" -f "$dockerfile" --push .
  echo "Pushed: ${REGISTRY}/${name}:${TAG}"
  printf '%s\n' "${REGISTRY}/${name}:${TAG}" >> "$IMAGE_FILE"

  if [ "${PUSH_LATEST:-false}" = "true" ]; then
    docker buildx build --platform linux/amd64 -t "${REGISTRY}/${name}:latest" -f "$dockerfile" --push .
    echo "Pushed: ${REGISTRY}/${name}:latest"
    printf '%s\n' "${REGISTRY}/${name}:latest" >> "$IMAGE_FILE"
  fi
}

build_and_push vibes-server server/Dockerfile
build_and_push vibes-web web/Dockerfile
build_and_push vibes-worker worker/Dockerfile

echo "Tag saved to ${TAG_FILE}"
echo "Images saved to ${IMAGE_FILE}"
echo "Worker set-image command:"
echo "kubectl -n vibes-platform set image deploy/vibes-worker worker=${REGISTRY}/vibes-worker:${TAG}"

if [ "${SET_IMAGE:-true}" = "true" ]; then
  : "${ACM_CERT_ARN:?ACM_CERT_ARN is required when SET_IMAGE=true}"
  : "${SERVER_HOST:?SERVER_HOST is required when SET_IMAGE=true}"
  : "${WEB_HOST:?WEB_HOST is required when SET_IMAGE=true}"
  : "${ROOT_HOST:?ROOT_HOST is required when SET_IMAGE=true}"

  export SERVER_IMAGE="${REGISTRY}/vibes-server:${TAG}"
  export WEB_IMAGE="${REGISTRY}/vibes-web:${TAG}"
  export WORKER_IMAGE="${REGISTRY}/vibes-worker:${TAG}"

  ./infra/k8s/server-apply.sh
  ./infra/k8s/web-apply.sh
  ./infra/k8s/worker-apply.sh
fi
