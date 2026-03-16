apiVersion: apps/v1
kind: Deployment
metadata:
  name: vibes-server
  namespace: vibes-platform
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: vibes-server
  template:
    metadata:
      annotations:
        replica.vibesplatform.ai/config-hash: ${SERVER_CONFIG_HASH}
      labels:
        app: vibes-server
    spec:
      serviceAccountName: vibes-server-sa
      containers:
        - name: server
          image: ${SERVER_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8000
          envFrom:
            - secretRef:
                name: vibes-server-env
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
            secretName: rds-ca-bundle
