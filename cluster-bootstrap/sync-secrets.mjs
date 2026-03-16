#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const layer1Dir = process.env.LAYER1_DIR || path.join(repoRoot, 'infra', 'envs', 'test-replica', 'layer1');
const outputDir = process.env.REPLICA_OUTPUT_DIR || path.join(repoRoot, 'deploy', '.generated', 'replica');
const terraformBin = process.env.TERRAFORM_BIN || path.join(repoRoot, 'scripts', 'replica', 'terraformw.sh');

function defaultQuotas() {
  return JSON.stringify({
    starter: { development: 60 },
    builder: { development: 100, testing: 60 },
    business: { development: 200, testing: 100, production: 750 },
    agency: { development: 500, testing: 250, production: 750 }
  });
}

function defaultPlanLimits() {
  return JSON.stringify({
    starter: { builds: 60, db_storage_gb: 2, bandwidth_gb: 15 },
    builder: { builds: 160, db_storage_gb: 8, bandwidth_gb: 50 },
    business: { builds: 500, db_storage_gb: 40, bandwidth_gb: 250 }
  });
}

function maxNumericString(rawValue, floorValue) {
  const parsed = Number(String(rawValue || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return String(floorValue);
  }
  return String(Math.max(Math.floor(parsed), floorValue));
}

function defaultNodeCosts() {
  return JSON.stringify({ platform: 200, customer: 350 });
}

function toEnv(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function validateSecret(secretName, payload, requiredKeys) {
  for (const key of requiredKeys) {
    const value = String(payload?.[key] || '').trim();
    if (!value || value === '__REPLACE_ME__') {
      throw new Error(`Secrets Manager secret ${secretName} is missing required key ${key}`);
    }
  }
}

async function run(cmd, args, options = {}) {
  const { stdout } = await execFile(cmd, args, {
    cwd: options.cwd,
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

async function terraformOutput(name) {
  return run(terraformBin, [`-chdir=${layer1Dir}`, 'output', '-raw', name], { cwd: repoRoot });
}

async function readSecret(secretId) {
  const raw = await run('aws', [
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    secretId,
    '--query',
    'SecretString',
    '--output',
    'text'
  ]);
  return JSON.parse(raw);
}

function formatEnv(entries) {
  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${toEnv(value).replace(/\n/g, '\\n')}`)
    .join('\n')}\n`;
}

await fs.mkdir(outputDir, { recursive: true });

const outputs = {
  accountId: await terraformOutput('account_id'),
  region: await terraformOutput('aws_region'),
  apiHost: await terraformOutput('api_host'),
  appHost: await terraformOutput('app_host'),
  rootHost: await terraformOutput('root_host'),
  route53ZoneId: await terraformOutput('route53_zone_id'),
  acmCertificateArn: await terraformOutput('acm_certificate_arn'),
  albGroupName: await terraformOutput('alb_group_name'),
  albLogBucket: await terraformOutput('alb_log_bucket'),
  albLogPrefix: await terraformOutput('alb_log_prefix'),
  customerAppRepositoryName: await terraformOutput('customer_app_repository_name'),
  dbHost: await terraformOutput('db_host'),
  dbPort: await terraformOutput('db_port'),
  platformDatabaseUrl: await terraformOutput('platform_database_url'),
  customerDbAdminUrl: await terraformOutput('customer_db_admin_url'),
  customerDbAdminUsername: await terraformOutput('customer_db_admin_username'),
  customerDbAdminPassword: await terraformOutput('customer_db_admin_password'),
  serverSecretName: await terraformOutput('server_manual_secret_name'),
  webSecretName: await terraformOutput('web_manual_secret_name'),
  workerSecretName: await terraformOutput('worker_manual_secret_name'),
  serverRepositoryUrl: await terraformOutput('server_repository_url'),
  webRepositoryUrl: await terraformOutput('web_repository_url'),
  workerRepositoryUrl: await terraformOutput('worker_repository_url'),
  workspaceSnapshotBucket: await terraformOutput('workspace_snapshot_bucket'),
  workspaceSnapshotPrefix: await terraformOutput('workspace_snapshot_prefix'),
  workerIrsaRoleArn: await terraformOutput('worker_irsa_role_arn')
};

const serverSecret = await readSecret(outputs.serverSecretName);
const webSecret = await readSecret(outputs.webSecretName);
const workerSecret = await readSecret(outputs.workerSecretName);

validateSecret(outputs.serverSecretName, serverSecret, ['OPENAI_API_KEY', 'OPENAI_MODEL', 'JWT_SECRET', 'ADMIN_API_KEY']);
validateSecret(outputs.workerSecretName, workerSecret, ['OPENAI_API_KEY', 'OPENAI_MODEL', 'GIT_TOKEN']);

const serverEnv = {
  DATABASE_URL: outputs.platformDatabaseUrl,
  JWT_SECRET: serverSecret.JWT_SECRET,
  DOMAIN: outputs.apiHost,
  OPENAI_API_KEY: serverSecret.OPENAI_API_KEY,
  OPENAI_MODEL: serverSecret.OPENAI_MODEL,
  RUN_MIGRATIONS: 'true',
  ALLOW_PASSWORD_BYPASS: serverSecret.ALLOW_PASSWORD_BYPASS || 'false',
  MAX_UPLOAD_MB: serverSecret.MAX_UPLOAD_MB || '100',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  DEMO_USERS: '',
  CORS_ORIGIN: [`https://${outputs.rootHost}`, `https://${outputs.appHost}`, `https://${outputs.apiHost}`].join(','),
  CORS_ORIGIN_EXTRA: serverSecret.CORS_ORIGIN_EXTRA || 'tauri://localhost,http://localhost',
  DEFAULT_USER_PLAN: serverSecret.DEFAULT_USER_PLAN || 'starter',
  PROD_LOG_COMMAND: 'kubectl -n $NAMESPACE logs deploy/$APP_NAME --tail=$LOG_LINES',
  DEV_LOG_COMMAND: 'kubectl -n $NAMESPACE logs deploy/$APP_NAME --tail=$LOG_LINES',
  PLATFORM_ENV: 'eks',
  RUNTIME_QUOTAS: serverSecret.RUNTIME_QUOTAS || defaultQuotas(),
  PLAN_LIMITS: serverSecret.PLAN_LIMITS || defaultPlanLimits(),
  NODEGROUP_MONTHLY_COSTS: serverSecret.NODEGROUP_MONTHLY_COSTS || defaultNodeCosts(),
  ADMIN_API_KEY: serverSecret.ADMIN_API_KEY,
  DESKTOP_DOWNLOAD_DIR: serverSecret.DESKTOP_DOWNLOAD_DIR || '/app/downloads'
};

const webEnv = {
  API_URL: `https://${outputs.apiHost}`,
  DOMAIN: outputs.rootHost,
  UPGRADE_URL: webSecret.UPGRADE_URL || `https://${outputs.rootHost}/pricing`
};

const workerEnv = {
  DATABASE_URL: outputs.platformDatabaseUrl,
  CUSTOMER_DB_ADMIN_URL: outputs.customerDbAdminUrl,
  CUSTOMER_DB_HOST: outputs.dbHost,
  CUSTOMER_DB_USER: outputs.customerDbAdminUsername,
  CUSTOMER_DB_PASSWORD: outputs.customerDbAdminPassword,
  CUSTOMER_DB_PORT: outputs.dbPort,
  CUSTOMER_DB_SSLMODE: 'verify-full',
  CUSTOMER_DB_SSLROOTCERT: '/etc/ssl/certs/rds-ca.pem',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  STARTER_REPO_URL: workerSecret.STARTER_REPO_URL || 'https://github.com/dscarlin/vibesplatform-starter-app.git',
  STARTER_REPO_REF: workerSecret.STARTER_REPO_REF || 'main',
  GIT_TOKEN: workerSecret.GIT_TOKEN,
  SERVER_SOCKET_URL: 'http://vibes-server.vibes-platform.svc.cluster.local:80',
  DOMAIN: outputs.apiHost,
  PLATFORM_ENV: 'k8s',
  APP_DOMAIN: outputs.rootHost,
  AWS_REGION: outputs.region,
  AWS_ACCOUNT_ID: outputs.accountId,
  ECR_REPO: outputs.customerAppRepositoryName,
  ACM_CERT_ARN: outputs.acmCertificateArn,
  DELETE_ECR_IMAGES: workerSecret.DELETE_ECR_IMAGES || 'true',
  AUTO_DNS: 'true',
  ROUTE53_HOSTED_ZONE_ID: outputs.route53ZoneId,
  HEALTHCHECK_PATH: workerSecret.HEALTHCHECK_PATH || '/',
  HEALTHCHECK_TIMEOUT_MS: workerSecret.HEALTHCHECK_TIMEOUT_MS || '30000',
  HEALTHCHECK_INTERVAL_MS: workerSecret.HEALTHCHECK_INTERVAL_MS || '3000',
  HEALTHCHECK_LOG_LINES: workerSecret.HEALTHCHECK_LOG_LINES || '1200',
  EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS: maxNumericString(workerSecret.EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS, 8),
  READINESS_PROBE_PERIOD_SECONDS: workerSecret.READINESS_PROBE_PERIOD_SECONDS || '10',
  READINESS_PROBE_TIMEOUT_SECONDS: workerSecret.READINESS_PROBE_TIMEOUT_SECONDS || '2',
  READINESS_PROBE_FAILURE_THRESHOLD: workerSecret.READINESS_PROBE_FAILURE_THRESHOLD || '2',
  READINESS_PROBE_SUCCESS_THRESHOLD: workerSecret.READINESS_PROBE_SUCCESS_THRESHOLD || '1',
  STARTUP_PROBE_PERIOD_SECONDS: workerSecret.STARTUP_PROBE_PERIOD_SECONDS || '5',
  STARTUP_PROBE_TIMEOUT_SECONDS: workerSecret.STARTUP_PROBE_TIMEOUT_SECONDS || '2',
  STARTUP_PROBE_FAILURE_THRESHOLD: workerSecret.STARTUP_PROBE_FAILURE_THRESHOLD || '40',
  ALB_HEALTHCHECK_INTERVAL_SECONDS: workerSecret.ALB_HEALTHCHECK_INTERVAL_SECONDS || '15',
  ALB_HEALTHCHECK_TIMEOUT_SECONDS: workerSecret.ALB_HEALTHCHECK_TIMEOUT_SECONDS || '5',
  ALB_HEALTHY_THRESHOLD_COUNT: workerSecret.ALB_HEALTHY_THRESHOLD_COUNT || '2',
  ALB_UNHEALTHY_THRESHOLD_COUNT: workerSecret.ALB_UNHEALTHY_THRESHOLD_COUNT || '2',
  DEV_DEPLOY_COMMAND: '/app/infra/k8s/deploy.sh',
  TEST_DEPLOY_COMMAND: '/app/infra/k8s/deploy.sh',
  PROD_DEPLOY_COMMAND: '/app/infra/k8s/deploy.sh',
  DEV_DELETE_COMMAND: '/app/infra/k8s/delete.sh',
  TEST_DELETE_COMMAND: '/app/infra/k8s/delete.sh',
  PROD_DELETE_COMMAND: '/app/infra/k8s/delete.sh',
  WORKSPACE_POD_NAMESPACE: 'vibes-development',
  WORKER_POD_NAMESPACE: 'vibes-platform',
  WORKSPACE_STORAGE_SIZE: workerSecret.WORKSPACE_STORAGE_SIZE || '10Gi',
  WORKSPACE_IDLE_TTL_MS: workerSecret.WORKSPACE_IDLE_TTL_MS || '1200000',
  WORKSPACE_PREVIEW_START_TIMEOUT_MS: workerSecret.WORKSPACE_PREVIEW_START_TIMEOUT_MS || '120000',
  WORKSPACE_HEARTBEAT_STALE_MS: workerSecret.WORKSPACE_HEARTBEAT_STALE_MS || '120000',
  WORKSPACE_RECONCILE_INTERVAL_MS: workerSecret.WORKSPACE_RECONCILE_INTERVAL_MS || '60000',
  WORKSPACE_POD_CPU_REQUEST: workerSecret.WORKSPACE_POD_CPU_REQUEST || '200m',
  WORKSPACE_POD_CPU_LIMIT: workerSecret.WORKSPACE_POD_CPU_LIMIT || '1500m',
  WORKSPACE_POD_MEM_REQUEST: workerSecret.WORKSPACE_POD_MEM_REQUEST || '512Mi',
  WORKSPACE_POD_MEM_LIMIT: workerSecret.WORKSPACE_POD_MEM_LIMIT || '2Gi',
  WORKSPACE_STORAGE_CLASS: 'gp3',
  WORKSPACE_SNAPSHOT_BUCKET: outputs.workspaceSnapshotBucket,
  WORKSPACE_SNAPSHOT_PREFIX: outputs.workspaceSnapshotPrefix,
  DEV_SCALE_TO_ZERO_AFTER_MS: workerSecret.DEV_SCALE_TO_ZERO_AFTER_MS || '900000',
  TEST_SCALE_TO_ZERO_AFTER_MS: workerSecret.TEST_SCALE_TO_ZERO_AFTER_MS || '10800000',
  SCALE_TO_ZERO_INTERVAL_MS: workerSecret.SCALE_TO_ZERO_INTERVAL_MS || '60000',
  CODEX_COMMAND_TEMPLATE: 'OPENAI_API_KEY="$OPENAI_API_KEY" codex exec --skip-git-repo-check --json -o "$CODEX_RESPONSE_FILE" --yolo --ephemeral -m "$OPENAI_MODEL" -s danger-full-access "$CODEX_PROMPT"',
  CODEX_COMMAND_TEMPLATE_RESUME: 'OPENAI_API_KEY="$OPENAI_API_KEY" codex exec --skip-git-repo-check --json -o "$CODEX_RESPONSE_FILE" --yolo --ephemeral -m "$OPENAI_MODEL" --sandbox danger-full-access resume "$CODEX_THREAD_ID" "$CODEX_PROMPT"',
  OPENAI_MODEL: workerSecret.OPENAI_MODEL,
  OPENAI_API_KEY: workerSecret.OPENAI_API_KEY,
  DEMO_MODE: 'true',
  RUNTIME_QUOTAS: workerSecret.RUNTIME_QUOTAS || defaultQuotas(),
  PLAN_LIMITS: workerSecret.PLAN_LIMITS || defaultPlanLimits(),
  RUNTIME_QUOTA_INTERVAL_MS: workerSecret.RUNTIME_QUOTA_INTERVAL_MS || '60000',
  ALB_LOG_BUCKET: outputs.albLogBucket,
  ALB_LOG_PREFIX: `${outputs.albLogPrefix}/AWSLogs/${outputs.accountId}/elasticloadbalancing/${outputs.region}`,
  ALB_LOG_REGION: outputs.region,
  DEV_CPU_REQUEST: workerSecret.DEV_CPU_REQUEST || '100m',
  DEV_CPU_LIMIT: workerSecret.DEV_CPU_LIMIT || '500m',
  DEV_MEM_REQUEST: workerSecret.DEV_MEM_REQUEST || '256Mi',
  DEV_MEM_LIMIT: workerSecret.DEV_MEM_LIMIT || '512Mi',
  TEST_CPU_REQUEST: workerSecret.TEST_CPU_REQUEST || '200m',
  TEST_CPU_LIMIT: workerSecret.TEST_CPU_LIMIT || '1',
  TEST_MEM_REQUEST: workerSecret.TEST_MEM_REQUEST || '512Mi',
  TEST_MEM_LIMIT: workerSecret.TEST_MEM_LIMIT || '1Gi',
  PROD_CPU_REQUEST: workerSecret.PROD_CPU_REQUEST || '300m',
  PROD_CPU_LIMIT: workerSecret.PROD_CPU_LIMIT || '1500m',
  PROD_MEM_REQUEST: workerSecret.PROD_MEM_REQUEST || '512Mi',
  PROD_MEM_LIMIT: workerSecret.PROD_MEM_LIMIT || '2Gi',
  CUSTOMER_NODEGROUP_ENABLED: 'true',
  CUSTOMER_NODEGROUP_LABEL: 'nodegroup',
  CUSTOMER_NODEGROUP_VALUE: 'customer',
  CUSTOMER_NODEGROUP_TAINT_KEY: 'nodegroup',
  CUSTOMER_NODEGROUP_TAINT_VALUE: 'customer',
  QUEUE_BACKLOG_THRESHOLD: workerSecret.QUEUE_BACKLOG_THRESHOLD || '5',
  QUEUE_MONITOR_INTERVAL_MS: workerSecret.QUEUE_MONITOR_INTERVAL_MS || '60000',
  ALERT_COOLDOWN_MS: workerSecret.ALERT_COOLDOWN_MS || '600000',
  ALB_GROUP_NAME: outputs.albGroupName,
  ALB_GROUP_ORDER: workerSecret.ALB_GROUP_ORDER || '50'
};

const metadataEnv = {
  AWS_REGION: outputs.region,
  ACCOUNT_ID: outputs.accountId,
  CLUSTER_NAME: await terraformOutput('cluster_name'),
  ROOT_HOST: outputs.rootHost,
  APP_HOST: outputs.appHost,
  API_HOST: outputs.apiHost,
  ROUTE53_ZONE_ID: outputs.route53ZoneId,
  ACM_CERT_ARN: outputs.acmCertificateArn,
  ALB_GROUP_NAME: outputs.albGroupName,
  ALB_LOG_BUCKET: outputs.albLogBucket,
  ALB_LOG_PREFIX: outputs.albLogPrefix,
  SERVER_REPOSITORY_URL: outputs.serverRepositoryUrl,
  WEB_REPOSITORY_URL: outputs.webRepositoryUrl,
  WORKER_REPOSITORY_URL: outputs.workerRepositoryUrl,
  CUSTOMER_APP_REPOSITORY_NAME: outputs.customerAppRepositoryName,
  WORKER_IRSA_ROLE_ARN: outputs.workerIrsaRoleArn
};

await Promise.all([
  fs.writeFile(path.join(outputDir, 'server.env'), formatEnv(serverEnv), 'utf8'),
  fs.writeFile(path.join(outputDir, 'web.env'), formatEnv(webEnv), 'utf8'),
  fs.writeFile(path.join(outputDir, 'worker.env'), formatEnv(workerEnv), 'utf8'),
  fs.writeFile(path.join(outputDir, 'metadata.env'), formatEnv(metadataEnv), 'utf8')
]);

console.log(`[replica] Wrote server.env, web.env, worker.env, and metadata.env into ${outputDir}`);
