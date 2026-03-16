apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vibes-web
  namespace: vibes-platform
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: ${ACM_CERT_ARN}
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/group.name: ${ALB_GROUP_NAME}
    alb.ingress.kubernetes.io/group.order: '${ALB_GROUP_ORDER_WEB}'
    alb.ingress.kubernetes.io/load-balancer-attributes: "${ALB_LOAD_BALANCER_ATTRIBUTES}"
spec:
  ingressClassName: alb
  rules:
    - host: ${WEB_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: vibes-web
                port:
                  number: 80
    - host: ${ROOT_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: vibes-web
                port:
                  number: 80
