#!/usr/bin/env sh
set -eu

CLUSTER_NAME="${CLUSTER_NAME:-vibes-platform}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO="${ECR_REPO:-vibes-app}"

if ! command -v eksctl >/dev/null 2>&1; then
  echo "eksctl is required. Install: https://eksctl.io/" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi

echo "Deleting EKS cluster ${CLUSTER_NAME} in ${AWS_REGION}..."
eksctl delete cluster --name "${CLUSTER_NAME}" --region "${AWS_REGION}" --wait

echo "Optional: delete ECR repo ${ECR_REPO} (set DELETE_ECR=true to enable)."
if [ "${DELETE_ECR:-false}" = "true" ]; then
  aws ecr delete-repository --repository-name "${ECR_REPO}" --region "${AWS_REGION}" --force
fi

echo "Cluster deleted."
