apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${PLATFORM_WEB_NAME}
  namespace: ${PLATFORM_NAMESPACE}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: ${PLATFORM_WEB_NAME}
  template:
    metadata:
      annotations:
        replica.vibesplatform.ai/config-hash: ${WEB_CONFIG_HASH}
      labels:
        app: ${PLATFORM_WEB_NAME}
    spec:
      containers:
        - name: web
          image: ${WEB_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          envFrom:
            - secretRef:
                name: ${PLATFORM_WEB_ENV_SECRET_NAME}
          readinessProbe:
            httpGet:
              path: /
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
