apiVersion: apps/v1
kind: Deployment
metadata:
  name: vibes-web
  namespace: vibes-platform
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: vibes-web
  template:
    metadata:
      annotations:
        replica.vibesplatform.ai/config-hash: ${WEB_CONFIG_HASH}
      labels:
        app: vibes-web
    spec:
      containers:
        - name: web
          image: ${WEB_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          envFrom:
            - secretRef:
                name: vibes-web-env
          readinessProbe:
            httpGet:
              path: /
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
