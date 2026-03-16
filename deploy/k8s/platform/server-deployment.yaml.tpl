apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${PLATFORM_SERVER_NAME}
  namespace: ${PLATFORM_NAMESPACE}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: ${PLATFORM_SERVER_NAME}
  template:
    metadata:
      annotations:
        replica.vibesplatform.ai/config-hash: ${SERVER_CONFIG_HASH}
      labels:
        app: ${PLATFORM_SERVER_NAME}
    spec:
      serviceAccountName: ${PLATFORM_SERVER_SERVICE_ACCOUNT_NAME}
      containers:
        - name: server
          image: ${SERVER_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8000
          envFrom:
            - secretRef:
                name: ${PLATFORM_SERVER_ENV_SECRET_NAME}
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 30
            periodSeconds: 15
          volumeMounts:
            - name: rds-ca
              mountPath: /etc/ssl/certs/rds-ca.pem
              subPath: rds-ca.pem
              readOnly: true
      volumes:
        - name: rds-ca
          secret:
            secretName: ${PLATFORM_RDS_CA_SECRET_NAME}
