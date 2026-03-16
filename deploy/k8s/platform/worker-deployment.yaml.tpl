apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${PLATFORM_WORKER_NAME}
  namespace: ${PLATFORM_NAMESPACE}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: ${PLATFORM_WORKER_NAME}
  template:
    metadata:
      annotations:
        replica.vibesplatform.ai/config-hash: ${WORKER_CONFIG_HASH}
      labels:
        app: ${PLATFORM_WORKER_NAME}
    spec:
      serviceAccountName: ${PLATFORM_WORKER_SERVICE_ACCOUNT_NAME}
      containers:
        - name: worker
          image: ${WORKER_IMAGE}
          imagePullPolicy: IfNotPresent
          workingDir: /
          envFrom:
            - secretRef:
                name: ${PLATFORM_WORKER_ENV_SECRET_NAME}
          env:
            - name: GIT_SSL_CAINFO
              value: /etc/ssl/certs/ca-certificates.crt
            - name: PATH
              value: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
          volumeMounts:
            - name: rds-ca
              mountPath: /etc/ssl/certs/rds-ca.pem
              subPath: rds-ca.pem
              readOnly: true
      volumes:
        - name: rds-ca
          secret:
            secretName: ${PLATFORM_RDS_CA_SECRET_NAME}
