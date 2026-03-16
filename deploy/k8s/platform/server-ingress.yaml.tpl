apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${PLATFORM_SERVER_NAME}
  namespace: ${PLATFORM_NAMESPACE}
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: ${ACM_CERT_ARN}
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: /health
    alb.ingress.kubernetes.io/group.name: ${ALB_GROUP_NAME}
    alb.ingress.kubernetes.io/group.order: '${ALB_GROUP_ORDER_SERVER}'
    alb.ingress.kubernetes.io/load-balancer-attributes: "${ALB_LOAD_BALANCER_ATTRIBUTES}"
spec:
  ingressClassName: alb
  rules:
    - host: ${SERVER_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${PLATFORM_SERVER_NAME}
                port:
                  number: 80
