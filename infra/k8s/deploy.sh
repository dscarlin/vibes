#!/usr/bin/env sh
set -eu

# Ensure standard system paths are present for exec plugins (aws) and core utilities.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

NAMESPACE="${NAMESPACE:-}"
if [ -z "${SNAPSHOT_PATH:-}" ]; then
  echo "SNAPSHOT_PATH required" >&2
  exit 1
fi
if [ -z "${ENV_FILE:-}" ]; then
  echo "ENV_FILE required" >&2
  exit 1
fi
if [ -z "${PROJECT_ID:-}" ] || [ -z "${ENVIRONMENT:-}" ]; then
  echo "PROJECT_ID and ENVIRONMENT required" >&2
  exit 1
fi
if [ -z "${AWS_REGION:-}" ] || [ -z "${AWS_ACCOUNT_ID:-}" ] || [ -z "${ECR_REPO:-}" ]; then
  echo "AWS_REGION, AWS_ACCOUNT_ID, ECR_REPO required" >&2
  exit 1
fi
if [ -z "${APP_HOST:-}" ]; then
  echo "APP_HOST required" >&2
  exit 1
fi

if [ -z "$NAMESPACE" ]; then
  NAMESPACE="vibes-${ENVIRONMENT}"
fi
if [ -z "${APP_NAME:-}" ]; then
  APP_NAME="vibes-app-${PROJECT_ID}"
fi

# Resource limits per environment to prevent noisy neighbors from destabilizing nodes.
# You can override via env:
#   APP_CPU_REQUEST / APP_CPU_LIMIT / APP_MEM_REQUEST / APP_MEM_LIMIT
#   DEV_CPU_REQUEST / DEV_CPU_LIMIT / DEV_MEM_REQUEST / DEV_MEM_LIMIT
#   TEST_CPU_REQUEST / TEST_CPU_LIMIT / TEST_MEM_REQUEST / TEST_MEM_LIMIT
#   PROD_CPU_REQUEST / PROD_CPU_LIMIT / PROD_MEM_REQUEST / PROD_MEM_LIMIT
ENVIRONMENT_KEY="$ENVIRONMENT"
case "$ENVIRONMENT_KEY" in
  dev) ENVIRONMENT_KEY="development" ;;
  prod) ENVIRONMENT_KEY="production" ;;
esac

if [ -n "${APP_CPU_REQUEST:-}" ]; then
  CPU_REQUEST="$APP_CPU_REQUEST"
  CPU_LIMIT="${APP_CPU_LIMIT:-$APP_CPU_REQUEST}"
  MEM_REQUEST="${APP_MEM_REQUEST:-256Mi}"
  MEM_LIMIT="${APP_MEM_LIMIT:-$MEM_REQUEST}"
else
  case "$ENVIRONMENT_KEY" in
    development)
      CPU_REQUEST="${DEV_CPU_REQUEST:-100m}"
      CPU_LIMIT="${DEV_CPU_LIMIT:-500m}"
      MEM_REQUEST="${DEV_MEM_REQUEST:-256Mi}"
      MEM_LIMIT="${DEV_MEM_LIMIT:-512Mi}"
      ;;
    testing)
      CPU_REQUEST="${TEST_CPU_REQUEST:-200m}"
      CPU_LIMIT="${TEST_CPU_LIMIT:-1}"
      MEM_REQUEST="${TEST_MEM_REQUEST:-512Mi}"
      MEM_LIMIT="${TEST_MEM_LIMIT:-1Gi}"
      ;;
    production)
      CPU_REQUEST="${PROD_CPU_REQUEST:-300m}"
      CPU_LIMIT="${PROD_CPU_LIMIT:-1500m}"
      MEM_REQUEST="${PROD_MEM_REQUEST:-512Mi}"
      MEM_LIMIT="${PROD_MEM_LIMIT:-2Gi}"
      ;;
    *)
      CPU_REQUEST="${DEV_CPU_REQUEST:-100m}"
      CPU_LIMIT="${DEV_CPU_LIMIT:-500m}"
      MEM_REQUEST="${DEV_MEM_REQUEST:-256Mi}"
      MEM_LIMIT="${DEV_MEM_LIMIT:-512Mi}"
      ;;
  esac
fi

echo "deploy.sh resources: requests cpu=${CPU_REQUEST} mem=${MEM_REQUEST} | limits cpu=${CPU_LIMIT} mem=${MEM_LIMIT}"
WORKDIR="/tmp/vibes-build-${PROJECT_ID}-${ENVIRONMENT}"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
tar -xzf "$SNAPSHOT_PATH" -C "$WORKDIR"

strip_env_conflicts() {
  env_file="$1"
  workdir="$2"
  if [ ! -f "$env_file" ]; then
    return
  fi
  find "$workdir" -maxdepth 3 -name '.env*' -type f \
    -not -name '*.example' -not -name '*.sample' -exec sh -c '
      env_file="$1"
      shift
      for file in "$@"; do
        awk -F= '"'"'
          FNR==NR {
            key=$1;
            sub(/^[[:space:]]*export[[:space:]]+/, "", key);
            sub(/[[:space:]]+$/, "", key);
            if (key != "" && key !~ /^#/) keys[key]=1;
            next
          }
          {
            line=$0;
            sub(/^[[:space:]]*export[[:space:]]+/, "", line);
            split(line, parts, "=");
            key=parts[1];
            sub(/[[:space:]]+$/, "", key);
            if (key=="" || key ~ /^#/) { print $0; next }
            if (!(key in keys)) print $0
          }
        '"'"' "$env_file" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
      done
    ' sh "$env_file" {} +
}

strip_env_conflicts "$ENV_FILE" "$WORKDIR"

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_TAG="${PROJECT_ID}-${ENVIRONMENT}-${DEPLOY_TAG:-${COMMIT_HASH:-manual}}"
IMAGE="$REGISTRY/$ECR_REPO:$IMAGE_TAG"

KUBECTL="${KUBECTL:-/usr/local/bin/kubectl}"
if [ ! -x "$KUBECTL" ]; then
  echo "kubectl not found at $KUBECTL" >&2
  exit 1
fi

echo "deploy.sh resolved: APP_NAME=${APP_NAME} ENV_FILE=${ENV_FILE} SNAPSHOT_PATH=${SNAPSHOT_PATH} APP_HOST=${APP_HOST} NAMESPACE=${NAMESPACE} IMAGE=${IMAGE}"
CUSTOMER_NODEGROUP_ENABLED="${CUSTOMER_NODEGROUP_ENABLED:-}"
NODE_PLACEMENT_BLOCK=""
if [ "$CUSTOMER_NODEGROUP_ENABLED" = "true" ]; then
  CUSTOMER_NODEGROUP_LABEL="${CUSTOMER_NODEGROUP_LABEL:-nodegroup}"
  CUSTOMER_NODEGROUP_VALUE="${CUSTOMER_NODEGROUP_VALUE:-customer}"
  CUSTOMER_NODEGROUP_TAINT_KEY="${CUSTOMER_NODEGROUP_TAINT_KEY:-nodegroup}"
  CUSTOMER_NODEGROUP_TAINT_VALUE="${CUSTOMER_NODEGROUP_TAINT_VALUE:-customer}"
  if "$KUBECTL" get nodes -l "${CUSTOMER_NODEGROUP_LABEL}=${CUSTOMER_NODEGROUP_VALUE}" --no-headers 2>/dev/null | grep -q .; then
    NODE_PLACEMENT_BLOCK=$(cat <<EOF
      nodeSelector:
        ${CUSTOMER_NODEGROUP_LABEL}: ${CUSTOMER_NODEGROUP_VALUE}
      tolerations:
        - key: ${CUSTOMER_NODEGROUP_TAINT_KEY}
          operator: Equal
          value: ${CUSTOMER_NODEGROUP_TAINT_VALUE}
          effect: NoSchedule
EOF
)
    echo "deploy.sh scheduling: nodeSelector ${CUSTOMER_NODEGROUP_LABEL}=${CUSTOMER_NODEGROUP_VALUE} taint ${CUSTOMER_NODEGROUP_TAINT_KEY}=${CUSTOMER_NODEGROUP_TAINT_VALUE}"
  else
    echo "deploy.sh warning: no nodes match ${CUSTOMER_NODEGROUP_LABEL}=${CUSTOMER_NODEGROUP_VALUE}; scheduling without node selector"
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ENV_FILE missing: $ENV_FILE" >&2
  exit 1
fi

# Resolve app port from env file (defaults to 4000 for starter templates).
APP_PORT="${APP_PORT:-}"
if [ -z "$APP_PORT" ]; then
  APP_PORT="$(awk -F= '/^PORT=/{print $2; exit}' "$ENV_FILE" | tr -d '\r' | tr -d '"' | tr -d "'")"
fi
APP_PORT="${APP_PORT:-3000}"
echo "deploy.sh app port: ${APP_PORT}"

"$KUBECTL" create namespace "$NAMESPACE" --dry-run=client -o yaml | "$KUBECTL" apply -f -
"$KUBECTL" -n "$NAMESPACE" delete secret "$APP_NAME-env" --ignore-not-found
"$KUBECTL" -n "$NAMESPACE" create secret generic "$APP_NAME-env" --from-env-file="$ENV_FILE"
RDS_CA_PATH="${RDS_CA_PATH:-/etc/ssl/certs/rds-ca.pem}"
if [ ! -f "$RDS_CA_PATH" ]; then
  echo "RDS CA bundle missing at $RDS_CA_PATH" >&2
  exit 1
fi
"$KUBECTL" -n "$NAMESPACE" create secret generic rds-ca-bundle \
  --from-file=rds-ca.pem="$RDS_CA_PATH" \
  --dry-run=client -o yaml | "$KUBECTL" apply -f -

AWS_BIN="$(command -v aws 2>/dev/null || true)"
if [ -n "$AWS_BIN" ]; then
  # Ensure repo exists
  if ! "$AWS_BIN" ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1; then
    set +e
    CREATE_ERR="$("$AWS_BIN" ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" 2>&1)"
    CREATE_STATUS=$?
    set -e
    if [ $CREATE_STATUS -ne 0 ]; then
      echo "$CREATE_ERR" | grep -q 'RepositoryAlreadyExistsException' && true || {
        echo "$CREATE_ERR" >&2
        exit $CREATE_STATUS
      }
    fi
  fi
fi

if [ ! -f "$WORKDIR/Dockerfile" ]; then
  cat > "$WORKDIR/Dockerfile" <<'DOCKER'
FROM node:20
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm install; elif [ -f pnpm-lock.yaml ]; then npm i -g pnpm && pnpm i; elif [ -f yarn.lock ]; then yarn install; else npm install; fi
EXPOSE 3000
CMD ["sh", "-lc", "${START_COMMAND:-npm start}"]
DOCKER
fi

if command -v kaniko >/dev/null 2>&1; then
  DOCKER_CONFIG="/tmp/kaniko/.docker"
  mkdir -p "$DOCKER_CONFIG"
  ECR_PASSWORD="$("$AWS_BIN" ecr get-login-password --region "$AWS_REGION")"
  cat > "$DOCKER_CONFIG/config.json" <<EOF
{"auths":{"$REGISTRY":{"username":"AWS","password":"$ECR_PASSWORD"}}}
EOF
  /usr/local/bin/kaniko \
    --context "$WORKDIR" \
    --dockerfile "$WORKDIR/Dockerfile" \
    --destination "$IMAGE"
elif command -v docker >/dev/null 2>&1; then
  "$AWS_BIN" ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
  docker build -t "$IMAGE" "$WORKDIR"
  docker push "$IMAGE"
else
  echo "Neither docker nor kaniko is available" >&2
  exit 1
fi

"$KUBECTL" -n "$NAMESPACE" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP_NAME}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${APP_NAME}
  template:
    metadata:
      labels:
        app: ${APP_NAME}
    spec:
${NODE_PLACEMENT_BLOCK}
      containers:
        - name: app
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          envFrom:
            - secretRef:
                name: ${APP_NAME}-env
          env:
            - name: PGSSLROOTCERT
              value: /etc/ssl/certs/rds-ca.pem
            - name: NODE_EXTRA_CA_CERTS
              value: /etc/ssl/certs/rds-ca.pem
          ports:
            - containerPort: ${APP_PORT}
          resources:
            requests:
              cpu: ${CPU_REQUEST}
              memory: ${MEM_REQUEST}
            limits:
              cpu: ${CPU_LIMIT}
              memory: ${MEM_LIMIT}
          volumeMounts:
            - name: rds-ca
              mountPath: /etc/ssl/certs/rds-ca.pem
              subPath: rds-ca.pem
              readOnly: true
      volumes:
        - name: rds-ca
          secret:
            secretName: rds-ca-bundle
            items:
              - key: rds-ca.pem
                path: rds-ca.pem
---
apiVersion: v1
kind: Service
metadata:
  name: ${APP_NAME}
spec:
  selector:
    app: ${APP_NAME}
  ports:
    - port: 80
      targetPort: ${APP_PORT}
EOF

ALB_GROUP_NAME="${ALB_GROUP_NAME:-vibes-shared}"
ALB_GROUP_ORDER="${ALB_GROUP_ORDER:-50}"
HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH:-/}"

case "$ENVIRONMENT_KEY" in
  development) HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH_DEV:-$HEALTHCHECK_PATH_DEFAULT}" ;;
  testing) HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH_TEST:-$HEALTHCHECK_PATH_DEFAULT}" ;;
  production) HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH_PROD:-$HEALTHCHECK_PATH_DEFAULT}" ;;
esac

if [ -z "${ACM_CERT_ARN:-}" ]; then
  echo "ACM_CERT_ARN required for ingress" >&2
  exit 1
fi
"$KUBECTL" -n "$NAMESPACE" apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${APP_NAME}
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: ${ACM_CERT_ARN}
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: ${HEALTHCHECK_PATH_DEFAULT}
    alb.ingress.kubernetes.io/success-codes: '200-399'
    alb.ingress.kubernetes.io/group.name: ${ALB_GROUP_NAME}
    alb.ingress.kubernetes.io/group.order: '${ALB_GROUP_ORDER}'
spec:
  ingressClassName: alb
  rules:
    - host: ${APP_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${APP_NAME}
                port:
                  number: 80
EOF

AUTO_DNS="${AUTO_DNS:-}"
if [ -n "$AUTO_DNS" ] && [ "$AUTO_DNS" != "false" ]; then
  echo "AUTO_DNS debug: AWS_BIN=${AWS_BIN:-<empty>}"
  if [ -n "${AWS_BIN:-}" ] && [ -x "$AWS_BIN" ]; then
    echo "AUTO_DNS debug: AWS_BIN is executable"
  else
    echo "AUTO_DNS debug: AWS_BIN is missing or not executable"
  fi
  if [ -x /usr/bin/python3 ]; then
    echo "AUTO_DNS debug: /usr/bin/python3 exists"
  else
    echo "AUTO_DNS debug: /usr/bin/python3 missing"
  fi
  if [ -x /bin/sh ]; then
    echo "AUTO_DNS debug: /bin/sh exists"
  else
    echo "AUTO_DNS debug: /bin/sh missing"
  fi
  if [ -z "$AWS_BIN" ]; then
    echo "AUTO_DNS enabled but aws CLI not available; skipping DNS update" >&2
    exit 0
  fi

  ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID:-}"
  if [ -z "$ROUTE53_HOSTED_ZONE_ID" ]; then
    if [ -z "${DOMAIN:-}" ]; then
      echo "AUTO_DNS enabled but DOMAIN not set; skipping DNS update" >&2
      exit 0
    fi
    ROUTE53_HOSTED_ZONE_ID="$("$AWS_BIN" route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --max-items 1 --query 'HostedZones[0].Id' --output text)"
    ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID#/hostedzone/}"
  fi
  if [ -z "$ROUTE53_HOSTED_ZONE_ID" ] || [ "$ROUTE53_HOSTED_ZONE_ID" = "None" ]; then
    echo "AUTO_DNS could not resolve Route53 hosted zone for ${DOMAIN}; skipping DNS update" >&2
    exit 0
  fi

  echo "AUTO_DNS enabled; waiting for ALB hostname..."
  ALB_DNS=""
  i=0
  while [ $i -lt 40 ]; do
    ALB_DNS="$("$KUBECTL" -n "$NAMESPACE" get ingress "$APP_NAME" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
    if [ -n "$ALB_DNS" ]; then
      break
    fi
    i=$((i + 1))
    read -r -t 3 _ || true
  done
  if [ -z "$ALB_DNS" ]; then
    echo "AUTO_DNS failed to read ALB hostname for ${APP_NAME}; skipping DNS update" >&2
    exit 0
  fi

  ALB_HZ_ID="$("$AWS_BIN" elbv2 describe-load-balancers --region "$AWS_REGION" --query "LoadBalancers[?DNSName=='${ALB_DNS}'].CanonicalHostedZoneId" --output text)"
  if [ -z "$ALB_HZ_ID" ] || [ "$ALB_HZ_ID" = "None" ]; then
    echo "AUTO_DNS failed to resolve ALB hosted zone for ${ALB_DNS}; skipping DNS update" >&2
    exit 0
  fi

  CHANGE_JSON="$(mktemp /tmp/route53-change-XXXXXX.json)"
  cat > "$CHANGE_JSON" <<EOF
{
  "Comment": "Route ${APP_HOST} to ALB",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${APP_HOST}.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_HZ_ID}",
          "DNSName": "${ALB_DNS}.",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
EOF
  "$AWS_BIN" route53 change-resource-record-sets --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" --change-batch "file://$CHANGE_JSON" >/dev/null
  echo "AUTO_DNS updated: ${APP_HOST} -> ${ALB_DNS} (zone ${ROUTE53_HOSTED_ZONE_ID})"
fi
