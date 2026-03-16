apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${PLATFORM_WORKER_SERVICE_ACCOUNT_NAME}
  namespace: ${PLATFORM_NAMESPACE}
  annotations:
    eks.amazonaws.com/role-arn: ${WORKER_IRSA_ROLE_ARN}
