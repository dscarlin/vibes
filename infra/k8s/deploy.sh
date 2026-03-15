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
SKIP_INGRESS="$(printf '%s' "${SKIP_INGRESS:-false}" | tr '[:upper:]' '[:lower:]')"

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
DEV_RUNTIME_MODE="$(printf '%s' "${DEV_RUNTIME_MODE:-pod}" | tr '[:upper:]' '[:lower:]')"
USE_DEV_POD_RUNTIME="false"
if [ "$ENVIRONMENT_KEY" = "development" ] && [ "$DEV_RUNTIME_MODE" != "deployment" ]; then
  USE_DEV_POD_RUNTIME="true"
fi

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
POD_NODE_PLACEMENT_BLOCK=""
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
    POD_NODE_PLACEMENT_BLOCK=$(cat <<EOF
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

IMAGE_PULL_POLICY="${APP_IMAGE_PULL_POLICY:-}"
if [ -z "$IMAGE_PULL_POLICY" ]; then
  if [ "$ENVIRONMENT_KEY" = "development" ]; then
    IMAGE_PULL_POLICY="${DEV_IMAGE_PULL_POLICY:-Always}"
  else
    IMAGE_PULL_POLICY="IfNotPresent"
  fi
fi
echo "deploy.sh image pull policy: ${IMAGE_PULL_POLICY}"

HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH:-/}"
case "$ENVIRONMENT_KEY" in
  development) HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH_DEV:-$HEALTHCHECK_PATH_DEFAULT}" ;;
  testing) HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH_TEST:-$HEALTHCHECK_PATH_DEFAULT}" ;;
  production) HEALTHCHECK_PATH_DEFAULT="${HEALTHCHECK_PATH_PROD:-$HEALTHCHECK_PATH_DEFAULT}" ;;
esac

APP_PROBE_PATH_DEFAULT="${APP_PROBE_PATH:-$HEALTHCHECK_PATH_DEFAULT}"
case "$ENVIRONMENT_KEY" in
  development) APP_PROBE_PATH_DEFAULT="${APP_PROBE_PATH_DEV:-$APP_PROBE_PATH_DEFAULT}" ;;
  testing) APP_PROBE_PATH_DEFAULT="${APP_PROBE_PATH_TEST:-$APP_PROBE_PATH_DEFAULT}" ;;
  production) APP_PROBE_PATH_DEFAULT="${APP_PROBE_PATH_PROD:-$APP_PROBE_PATH_DEFAULT}" ;;
esac

READINESS_PROBE_PERIOD_SECONDS="${READINESS_PROBE_PERIOD_SECONDS:-10}"
READINESS_PROBE_TIMEOUT_SECONDS="${READINESS_PROBE_TIMEOUT_SECONDS:-2}"
READINESS_PROBE_FAILURE_THRESHOLD="${READINESS_PROBE_FAILURE_THRESHOLD:-2}"
READINESS_PROBE_SUCCESS_THRESHOLD="${READINESS_PROBE_SUCCESS_THRESHOLD:-1}"
STARTUP_PROBE_PERIOD_SECONDS="${STARTUP_PROBE_PERIOD_SECONDS:-5}"
STARTUP_PROBE_TIMEOUT_SECONDS="${STARTUP_PROBE_TIMEOUT_SECONDS:-2}"
STARTUP_PROBE_FAILURE_THRESHOLD="${STARTUP_PROBE_FAILURE_THRESHOLD:-40}"
ALB_HEALTHCHECK_INTERVAL_SECONDS="${ALB_HEALTHCHECK_INTERVAL_SECONDS:-15}"
ALB_HEALTHCHECK_TIMEOUT_SECONDS="${ALB_HEALTHCHECK_TIMEOUT_SECONDS:-5}"
ALB_HEALTHY_THRESHOLD_COUNT="${ALB_HEALTHY_THRESHOLD_COUNT:-2}"
ALB_UNHEALTHY_THRESHOLD_COUNT="${ALB_UNHEALTHY_THRESHOLD_COUNT:-2}"

echo "deploy.sh health: probe_path=${APP_PROBE_PATH_DEFAULT} alb_path=${HEALTHCHECK_PATH_DEFAULT} alb_interval=${ALB_HEALTHCHECK_INTERVAL_SECONDS}s alb_healthy=${ALB_HEALTHY_THRESHOLD_COUNT}"

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

# Base/root dependency install.
RUN set -eux; \
    if find . -maxdepth 3 -name pnpm-lock.yaml -not -path '*/node_modules/*' | grep -q .; then npm i -g pnpm; fi; \
    if find . -maxdepth 3 -name yarn.lock -not -path '*/node_modules/*' | grep -q .; then corepack enable; fi; \
    find . -maxdepth 3 -name package.json -not -path '*/node_modules/*' | sort | while read -r pkg; do \
      dir="$(dirname "$pkg")"; \
      if [ -f "$dir/package-lock.json" ]; then \
        (cd "$dir" && npm install --include=dev --no-audit --no-fund); \
      elif [ -f "$dir/pnpm-lock.yaml" ]; then \
        (cd "$dir" && pnpm i --prod=false); \
      elif [ -f "$dir/yarn.lock" ]; then \
        (cd "$dir" && yarn install --production=false); \
      else \
        (cd "$dir" && npm install --include=dev --no-audit --no-fund); \
      fi; \
    done

# Starter-layout optimization: do expensive setup once at image build, not on every container boot.
RUN if [ -f scripts/start-all.js ] && [ -f server/package.json ] && [ -f web/package.json ]; then \
      (cd server && npm run prisma:generate --if-present && npm run build --if-present) && \
      (cd web && npm run build --if-present); \
    fi

EXPOSE 3000
CMD ["sh", "-lc", "if [ -n \"${START_COMMAND:-}\" ]; then exec sh -lc \"${START_COMMAND}\"; elif [ -f scripts/start-all.js ] && [ -f server/dist/index.js ]; then if [ -f server/package.json ] && ! node -e \"const fs=require('fs');const {createRequire}=require('module');const p=JSON.parse(fs.readFileSync('/app/server/package.json','utf8'));const deps=Object.keys(p.dependencies||{});const r=createRequire('/app/server/index.js');for(const d of deps){r.resolve(d);}\" >/dev/null 2>&1; then (cd server && npm install --include=dev --no-audit --no-fund); fi; exec node server/dist/index.js; elif [ -f scripts/start-all.js ] && [ -f server/index.js ]; then if [ -f server/package.json ] && ! node -e \"const fs=require('fs');const {createRequire}=require('module');const p=JSON.parse(fs.readFileSync('/app/server/package.json','utf8'));const deps=Object.keys(p.dependencies||{});const r=createRequire('/app/server/index.js');for(const d of deps){r.resolve(d);}\" >/dev/null 2>&1; then (cd server && npm install --include=dev --no-audit --no-fund); fi; exec node server/index.js; else exec npm start; fi"]
DOCKER
fi

BUILD_START_TS="$(date +%s)"
echo "deploy.sh phase: image build started (${IMAGE})"
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
BUILD_END_TS="$(date +%s)"
echo "deploy.sh phase: image build finished in $((BUILD_END_TS - BUILD_START_TS))s"

APPLY_START_TS="$(date +%s)"
echo "deploy.sh phase: applying kubernetes resources"
if [ "$USE_DEV_POD_RUNTIME" = "true" ]; then
  echo "deploy.sh mode: development single Pod (restartPolicy=Never)"
  "$KUBECTL" -n "$NAMESPACE" delete deployment "$APP_NAME" --ignore-not-found >/dev/null 2>&1 || true
  "$KUBECTL" -n "$NAMESPACE" delete pod -l app="$APP_NAME" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "$KUBECTL" -n "$NAMESPACE" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${APP_NAME}
  labels:
    app: ${APP_NAME}
spec:
${POD_NODE_PLACEMENT_BLOCK}
  restartPolicy: Never
  containers:
    - name: app
      image: ${IMAGE}
      imagePullPolicy: ${IMAGE_PULL_POLICY}
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
      readinessProbe:
        httpGet:
          path: ${APP_PROBE_PATH_DEFAULT}
          port: ${APP_PORT}
        periodSeconds: ${READINESS_PROBE_PERIOD_SECONDS}
        timeoutSeconds: ${READINESS_PROBE_TIMEOUT_SECONDS}
        failureThreshold: ${READINESS_PROBE_FAILURE_THRESHOLD}
        successThreshold: ${READINESS_PROBE_SUCCESS_THRESHOLD}
      startupProbe:
        httpGet:
          path: ${APP_PROBE_PATH_DEFAULT}
          port: ${APP_PORT}
        periodSeconds: ${STARTUP_PROBE_PERIOD_SECONDS}
        timeoutSeconds: ${STARTUP_PROBE_TIMEOUT_SECONDS}
        failureThreshold: ${STARTUP_PROBE_FAILURE_THRESHOLD}
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
else
  "$KUBECTL" -n "$NAMESPACE" delete pod -l app="$APP_NAME" --ignore-not-found --wait=false >/dev/null 2>&1 || true
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
          imagePullPolicy: ${IMAGE_PULL_POLICY}
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
          readinessProbe:
            httpGet:
              path: ${APP_PROBE_PATH_DEFAULT}
              port: ${APP_PORT}
            periodSeconds: ${READINESS_PROBE_PERIOD_SECONDS}
            timeoutSeconds: ${READINESS_PROBE_TIMEOUT_SECONDS}
            failureThreshold: ${READINESS_PROBE_FAILURE_THRESHOLD}
            successThreshold: ${READINESS_PROBE_SUCCESS_THRESHOLD}
          startupProbe:
            httpGet:
              path: ${APP_PROBE_PATH_DEFAULT}
              port: ${APP_PORT}
            periodSeconds: ${STARTUP_PROBE_PERIOD_SECONDS}
            timeoutSeconds: ${STARTUP_PROBE_TIMEOUT_SECONDS}
            failureThreshold: ${STARTUP_PROBE_FAILURE_THRESHOLD}
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
fi
APPLY_END_TS="$(date +%s)"
echo "deploy.sh phase: kubernetes resources applied in $((APPLY_END_TS - APPLY_START_TS))s"

ALB_GROUP_NAME="${ALB_GROUP_NAME:-vibes-shared}"
ALB_GROUP_ORDER="${ALB_GROUP_ORDER:-50}"

if [ "$SKIP_INGRESS" = "true" ]; then
  echo "deploy.sh ingress: skipped (SKIP_INGRESS=true)"
else
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
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: '${ALB_HEALTHCHECK_INTERVAL_SECONDS}'
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: '${ALB_HEALTHCHECK_TIMEOUT_SECONDS}'
    alb.ingress.kubernetes.io/healthy-threshold-count: '${ALB_HEALTHY_THRESHOLD_COUNT}'
    alb.ingress.kubernetes.io/unhealthy-threshold-count: '${ALB_UNHEALTHY_THRESHOLD_COUNT}'
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
fi

AUTO_DNS="${AUTO_DNS:-}"
if [ "$SKIP_INGRESS" != "true" ] && [ -n "$AUTO_DNS" ] && [ "$AUTO_DNS" != "false" ]; then
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
  ROUTE53_DOMAIN="${ROUTE53_DOMAIN:-${APP_DOMAIN:-${DOMAIN:-}}}"
  if [ -z "$ROUTE53_DOMAIN" ] && [ -n "${APP_HOST:-}" ]; then
    ROUTE53_DOMAIN="${APP_HOST#*.}"
  fi
  ROUTE53_DOMAIN="${ROUTE53_DOMAIN%.}"
  if [ -z "$ROUTE53_HOSTED_ZONE_ID" ]; then
    if [ -z "$ROUTE53_DOMAIN" ]; then
      echo "AUTO_DNS enabled but ROUTE53_DOMAIN/APP_DOMAIN/DOMAIN not set; skipping DNS update" >&2
      exit 0
    fi
    ROUTE53_HOSTED_ZONE_ID="$("$AWS_BIN" route53 list-hosted-zones-by-name --dns-name "$ROUTE53_DOMAIN" --max-items 1 --query 'HostedZones[0].Id' --output text)"
    ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID#/hostedzone/}"
  fi
  if [ -z "$ROUTE53_HOSTED_ZONE_ID" ] || [ "$ROUTE53_HOSTED_ZONE_ID" = "None" ]; then
    echo "AUTO_DNS could not resolve Route53 hosted zone for ${ROUTE53_DOMAIN}; skipping DNS update" >&2
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
