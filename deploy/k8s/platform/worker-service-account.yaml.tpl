apiVersion: v1
kind: ServiceAccount
metadata:
  name: worker-sa
  namespace: vibes-platform
  annotations:
    eks.amazonaws.com/role-arn: ${WORKER_IRSA_ROLE_ARN}
