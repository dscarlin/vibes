#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

if command -v terraform >/dev/null 2>&1; then
  exec terraform "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "terraform is not installed and docker is unavailable for fallback" >&2
  exit 1
fi

IMAGE="${TERRAFORM_DOCKER_IMAGE:-hashicorp/terraform:1.11.4}"

AWS_MOUNT_ARGS=""
if [ -d "${HOME}/.aws" ]; then
  AWS_MOUNT_ARGS="-v ${HOME}/.aws:${HOME}/.aws:ro"
fi

KUBE_MOUNT_ARGS=""
if [ -d "${HOME}/.kube" ]; then
  KUBE_MOUNT_ARGS="-v ${HOME}/.kube:${HOME}/.kube"
fi

DOCKER_ENV_ARGS="
  -e AWS_ACCESS_KEY_ID
  -e AWS_SECRET_ACCESS_KEY
  -e AWS_SESSION_TOKEN
  -e AWS_PROFILE
  -e AWS_REGION
  -e AWS_DEFAULT_REGION
  -e AWS_CONFIG_FILE
  -e AWS_SHARED_CREDENTIALS_FILE
  -e AWS_SDK_LOAD_CONFIG=1
  -e HOME
  -e KUBECONFIG
"

while IFS='=' read -r env_name _; do
  case "$env_name" in
    TF_* | CHECKPOINT_DISABLE)
      DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e $env_name"
      ;;
  esac
done <<EOF
$(env)
EOF

# shellcheck disable=SC2086
exec docker run --rm \
  ${DOCKER_ENV_ARGS} \
  -v "${REPO_ROOT}:${REPO_ROOT}" \
  ${AWS_MOUNT_ARGS} \
  ${KUBE_MOUNT_ARGS} \
  -w "${PWD}" \
  "$IMAGE" "$@"
