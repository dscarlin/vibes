#!/usr/bin/env sh
set -eu

CLUSTER_NAME="${CLUSTER_NAME:-vibes-platform}"
AWS_REGION="${AWS_REGION:-us-east-1}"
NODE_TYPE="${NODE_TYPE:-t3.medium}"
NODE_COUNT="${NODE_COUNT:-2}"
ECR_REPO="${ECR_REPO:-vibes-app}"

if ! command -v eksctl >/dev/null 2>&1; then
  echo "eksctl is required. Install: https://eksctl.io/" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required. Install: https://kubernetes.io/docs/tasks/tools/" >&2
  exit 1
fi

echo "Creating EKS cluster ${CLUSTER_NAME} in ${AWS_REGION}..."
eksctl create cluster \
  --name "${CLUSTER_NAME}" \
  --region "${AWS_REGION}" \
  --nodes "${NODE_COUNT}" \
  --node-type "${NODE_TYPE}" \
  --managed \
  --with-oidc \
  --tags "app=vibes,env=dev"

echo "Updating kubeconfig..."
aws eks update-kubeconfig --region "${AWS_REGION}" --name "${CLUSTER_NAME}"

echo "Ensuring ECR repo ${ECR_REPO} exists..."
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${AWS_REGION}" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "${ECR_REPO}" --region "${AWS_REGION}" >/dev/null

echo "Cluster ready."
