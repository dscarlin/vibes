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

function parseEnv(content) {
  const values = {};
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim().replace(/^export\s+/, '');
    let value = line.slice(index + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readOptionalEnvFile(filePath) {
  try {
    return parseEnv(await fs.readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
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

async function resolveTerraformOrDefault(name, fallback) {
  try {
    const value = await terraformOutput(name);
    return String(value || '').trim() || fallback;
  } catch {
    return fallback;
  }
}

async function readSecret(secretId, fallbackFile) {
  try {
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
  } catch (error) {
    const fallback = fallbackFile ? await readOptionalJson(fallbackFile) : null;
    if (fallback) return fallback;
    throw error;
  }
}

function repositoryNameFromUrl(repositoryUrl) {
  return String(repositoryUrl || '').trim().split('/').pop() || '';
}

function repositoryUrl(accountId, region, repositoryName) {
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}`;
}

async function repositoryExists(repositoryName, region) {
  if (!repositoryName) return false;
  try {
    await run('aws', [
      'ecr',
      'describe-repositories',
      '--region',
      region,
      '--repository-names',
      repositoryName,
      '--query',
      'repositories[0].repositoryName',
      '--output',
      'text'
    ]);
    return true;
  } catch {
    return false;
  }
}

async function currentAwsAccountId() {
  try {
    return await run('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  } catch {
    return '';
  }
}

function trimOr(value, fallback = '') {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

function normalizeDnsLabel(rawValue, fallback = 'replica') {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function inferReplicaLabel(rootHost, rootDomain) {
  const normalizedRootHost = trimOr(rootHost);
  const normalizedRootDomain = trimOr(rootDomain);
  if (normalizedRootHost && normalizedRootDomain && normalizedRootHost.endsWith(`.${normalizedRootDomain}`)) {
    return normalizeDnsLabel(normalizedRootHost.slice(0, -(normalizedRootDomain.length + 1)));
  }
  return normalizeDnsLabel(normalizedRootHost.split('.')[0] || '');
}

function deriveReplicaHosts(rootHost, rootDomain) {
  const normalizedRootDomain = trimOr(rootDomain, 'vibesplatform.ai');
  const normalizedRootHost = trimOr(rootHost, `replica.${normalizedRootDomain}`);
  const replicaLabel = inferReplicaLabel(normalizedRootHost, normalizedRootDomain);
  return {
    root: normalizedRootHost,
    app: `app-${replicaLabel}.${normalizedRootDomain}`,
    api: `api-${replicaLabel}.${normalizedRootDomain}`,
    projectDomain: normalizedRootDomain,
    projectSuffix: replicaLabel,
    wildcardHosts: normalizedRootDomain
  };
}

function albAttributePrefix(rawValue) {
  const value = trimOr(rawValue);
  if (!value) return 'alb-logs';
  const marker = '/AWSLogs/';
  const index = value.indexOf(marker);
  const prefix = index === -1 ? value : value.slice(0, index);
  return prefix.replace(/^\/+|\/+$/g, '') || 'alb-logs';
}

function formatEnv(entries) {
  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${toEnv(value).replace(/\n/g, '\\n')}`)
    .join('\n')}\n`;
}

await fs.mkdir(outputDir, { recursive: true });

const liveServerEnv = await readOptionalEnvFile(path.join(repoRoot, process.env.LIVE_SERVER_ENV_FILE || '.env.server'));
const liveWebEnv = await readOptionalEnvFile(path.join(repoRoot, process.env.LIVE_WEB_ENV_FILE || '.env.web'));
const liveWorkerEnv = await readOptionalEnvFile(path.join(repoRoot, process.env.LIVE_WORKER_ENV_FILE || '.env.worker'));
const manualSecretsDir = path.join(
  repoRoot,
  process.env.REPLICA_MANUAL_SECRETS_DIR || path.join('deploy', '.generated', 'replica', 'manual-secrets')
);
const liveRegion = trimOr(process.env.AWS_REGION || liveWorkerEnv.AWS_REGION, 'us-east-1');
const liveAccountId = trimOr(process.env.AWS_ACCOUNT_ID || liveWorkerEnv.AWS_ACCOUNT_ID, await currentAwsAccountId());
const liveRootDomain = trimOr(
  process.env.REPLICA_ROOT_DOMAIN || liveWebEnv.DOMAIN || liveWorkerEnv.APP_DOMAIN,
  'vibesplatform.ai'
);
const liveReplicaSubdomain = normalizeDnsLabel(process.env.REPLICA_SUBDOMAIN || 'replica');
const replicaHosts = deriveReplicaHosts(`${liveReplicaSubdomain}.${liveRootDomain}`, liveRootDomain);
const livePlatformDatabaseUrl = trimOr(process.env.PLATFORM_DATABASE_URL || liveServerEnv.DATABASE_URL);
const liveCustomerDbAdminUrl = trimOr(process.env.CUSTOMER_DB_ADMIN_URL || liveWorkerEnv.CUSTOMER_DB_ADMIN_URL);
const liveCustomerDbHost = trimOr(process.env.CUSTOMER_DB_HOST || liveWorkerEnv.CUSTOMER_DB_HOST);
const liveCustomerDbUser = trimOr(process.env.CUSTOMER_DB_USER || liveWorkerEnv.CUSTOMER_DB_USER);
const liveCustomerDbPassword = trimOr(process.env.CUSTOMER_DB_PASSWORD || liveWorkerEnv.CUSTOMER_DB_PASSWORD);
const liveCustomerDbPort = trimOr(process.env.CUSTOMER_DB_PORT || liveWorkerEnv.CUSTOMER_DB_PORT, '5432');
const liveRoute53ZoneId = trimOr(
  process.env.ROUTE53_ZONE_ID || process.env.ROUTE53_HOSTED_ZONE_ID || liveWorkerEnv.ROUTE53_HOSTED_ZONE_ID
);
const liveAcmCertArn = trimOr(process.env.ACM_CERT_ARN || liveWorkerEnv.ACM_CERT_ARN);
const liveWorkspaceSnapshotBucket = trimOr(process.env.WORKSPACE_SNAPSHOT_BUCKET || liveWorkerEnv.WORKSPACE_SNAPSHOT_BUCKET);
const liveWorkspaceSnapshotPrefix = trimOr(
  process.env.WORKSPACE_SNAPSHOT_PREFIX || liveWorkerEnv.WORKSPACE_SNAPSHOT_PREFIX,
  'project-workspaces'
);
const liveAlbLogBucket = trimOr(process.env.ALB_LOG_BUCKET || liveWorkerEnv.ALB_LOG_BUCKET);
const liveAlbLogPrefix = trimOr(process.env.ALB_LOG_PREFIX, albAttributePrefix(liveWorkerEnv.ALB_LOG_PREFIX));
const liveCustomerAppRepositoryName = trimOr(process.env.ECR_REPO || liveWorkerEnv.ECR_REPO, 'vibes-app');
const liveClusterName = trimOr(process.env.CLUSTER_NAME, 'vibes-platform');
const liveWorkerIrsaRoleArn = trimOr(process.env.WORKER_IRSA_ROLE_ARN, liveAccountId ? `arn:aws:iam::${liveAccountId}:role/vibes-worker-irsa` : '');
const liveAlbGroupName = trimOr(process.env.ALB_GROUP_NAME, `vibes-${liveReplicaSubdomain}-shared`);

const outputs = {
  accountId: await resolveTerraformOrDefault('account_id', liveAccountId),
  region: await resolveTerraformOrDefault('aws_region', liveRegion),
  rootDomain: await resolveTerraformOrDefault('root_domain', liveRootDomain),
  rootHost: trimOr(process.env.ROOT_HOST, replicaHosts.root),
  appHost: trimOr(process.env.APP_HOST, replicaHosts.app),
  apiHost: trimOr(process.env.API_HOST, replicaHosts.api),
  route53ZoneId: await resolveTerraformOrDefault('route53_zone_id', liveRoute53ZoneId),
  acmCertificateArn: await resolveTerraformOrDefault('acm_certificate_arn', liveAcmCertArn),
  albGroupName: await resolveTerraformOrDefault('alb_group_name', liveAlbGroupName),
  albLogBucket: await resolveTerraformOrDefault('alb_log_bucket', liveAlbLogBucket),
  albLogPrefix: await resolveTerraformOrDefault('alb_log_prefix', liveAlbLogPrefix),
  customerAppRepositoryName: await resolveTerraformOrDefault('customer_app_repository_name', liveCustomerAppRepositoryName),
  dbHost: await resolveTerraformOrDefault('db_host', liveCustomerDbHost),
  dbPort: await resolveTerraformOrDefault('db_port', liveCustomerDbPort),
  platformDatabaseUrl: await resolveTerraformOrDefault('platform_database_url', livePlatformDatabaseUrl),
  customerDbAdminUrl: await resolveTerraformOrDefault('customer_db_admin_url', liveCustomerDbAdminUrl),
  customerDbAdminUsername: await resolveTerraformOrDefault('customer_db_admin_username', liveCustomerDbUser),
  customerDbAdminPassword: await resolveTerraformOrDefault('customer_db_admin_password', liveCustomerDbPassword),
  serverSecretName: await resolveTerraformOrDefault('server_manual_secret_name', '/vibes/test-replica/server'),
  webSecretName: await resolveTerraformOrDefault('web_manual_secret_name', '/vibes/test-replica/web'),
  workerSecretName: await resolveTerraformOrDefault('worker_manual_secret_name', '/vibes/test-replica/worker'),
  serverRepositoryUrl: await resolveTerraformOrDefault(
    'server_repository_url',
    repositoryUrl(trimOr(liveAccountId), trimOr(liveRegion, 'us-east-1'), 'vibes-server')
  ),
  webRepositoryUrl: await resolveTerraformOrDefault(
    'web_repository_url',
    repositoryUrl(trimOr(liveAccountId), trimOr(liveRegion, 'us-east-1'), 'vibes-web')
  ),
  workerRepositoryUrl: await resolveTerraformOrDefault(
    'worker_repository_url',
    repositoryUrl(trimOr(liveAccountId), trimOr(liveRegion, 'us-east-1'), 'vibes-worker')
  ),
  workspaceSnapshotBucket: await resolveTerraformOrDefault('workspace_snapshot_bucket', liveWorkspaceSnapshotBucket),
  workspaceSnapshotPrefix: await resolveTerraformOrDefault('workspace_snapshot_prefix', liveWorkspaceSnapshotPrefix),
  workerIrsaRoleArn: await resolveTerraformOrDefault('worker_irsa_role_arn', liveWorkerIrsaRoleArn),
  clusterName: await resolveTerraformOrDefault('cluster_name', liveClusterName)
};

const platformNamespace = process.env.PLATFORM_NAMESPACE || 'vibes-platform';
const developmentNamespace = process.env.DEVELOPMENT_NAMESPACE || 'vibes-development';
const testingNamespace = process.env.TESTING_NAMESPACE || 'vibes-testing';
const productionNamespace = process.env.PRODUCTION_NAMESPACE || 'vibes-production';
const platformServerName = process.env.PLATFORM_SERVER_NAME || 'vibes-server';
const platformWebName = process.env.PLATFORM_WEB_NAME || 'vibes-web';
const platformWorkerName = process.env.PLATFORM_WORKER_NAME || 'vibes-worker';
const platformRedisName = process.env.PLATFORM_REDIS_NAME || 'redis';
const platformServerServiceAccountName = process.env.PLATFORM_SERVER_SERVICE_ACCOUNT_NAME || 'vibes-server-sa';
const platformWorkerServiceAccountName = process.env.PLATFORM_WORKER_SERVICE_ACCOUNT_NAME || 'worker-sa';
const platformServerMetricsClusterRoleName =
  process.env.PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME || 'vibes-admin-metrics-read';
const platformServerMetricsClusterRoleBindingName =
  process.env.PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME || 'vibes-admin-metrics-read';
const platformWorkerClusterRoleName = process.env.PLATFORM_WORKER_CLUSTER_ROLE_NAME || 'worker-deployer';
const platformWorkerClusterRoleBindingName =
  process.env.PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME || 'worker-deployer';
const projectHostDomain = process.env.PROJECT_HOST_DOMAIN || outputs.rootDomain;
const projectHostSuffix = process.env.PROJECT_HOST_SUFFIX || inferReplicaLabel(outputs.rootHost, outputs.rootDomain);
const projectWildcardHosts = process.env.PROJECT_WILDCARD_HOSTS || outputs.rootDomain;
const projectDatabasePrefix = process.env.PROJECT_DATABASE_PREFIX || 'vibes';
const platformServerSocketUrl =
  process.env.SERVER_SOCKET_URL || `http://${platformServerName}.${platformNamespace}.svc.cluster.local:80`;
const resolvedServerRepositoryName = (await repositoryExists(repositoryNameFromUrl(outputs.serverRepositoryUrl), outputs.region))
  ? repositoryNameFromUrl(outputs.serverRepositoryUrl)
  : 'vibes-server';
const resolvedWebRepositoryName = (await repositoryExists(repositoryNameFromUrl(outputs.webRepositoryUrl), outputs.region))
  ? repositoryNameFromUrl(outputs.webRepositoryUrl)
  : 'vibes-web';
const resolvedWorkerRepositoryName = (await repositoryExists(repositoryNameFromUrl(outputs.workerRepositoryUrl), outputs.region))
  ? repositoryNameFromUrl(outputs.workerRepositoryUrl)
  : 'vibes-worker';
const resolvedCustomerAppRepositoryName = (await repositoryExists(outputs.customerAppRepositoryName, outputs.region))
  ? outputs.customerAppRepositoryName
  : 'vibes-app';
const resolvedServerRepositoryUrl = repositoryUrl(outputs.accountId, outputs.region, resolvedServerRepositoryName);
const resolvedWebRepositoryUrl = repositoryUrl(outputs.accountId, outputs.region, resolvedWebRepositoryName);
const resolvedWorkerRepositoryUrl = repositoryUrl(outputs.accountId, outputs.region, resolvedWorkerRepositoryName);

const serverSecret = await readSecret(outputs.serverSecretName, path.join(manualSecretsDir, 'server.json'));
const webSecret = await readSecret(outputs.webSecretName, path.join(manualSecretsDir, 'web.json'));
const workerSecret = await readSecret(outputs.workerSecretName, path.join(manualSecretsDir, 'worker.json'));

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
  DESKTOP_DOWNLOAD_DIR: serverSecret.DESKTOP_DOWNLOAD_DIR || '/app/downloads',
  PLATFORM_NAMESPACE: platformNamespace,
  DEVELOPMENT_NAMESPACE: developmentNamespace,
  TESTING_NAMESPACE: testingNamespace,
  PRODUCTION_NAMESPACE: productionNamespace,
  RUNTIME_NAMESPACE_DEVELOPMENT: developmentNamespace,
  RUNTIME_NAMESPACE_TESTING: testingNamespace,
  RUNTIME_NAMESPACE_PRODUCTION: productionNamespace
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
  SERVER_SOCKET_URL: platformServerSocketUrl,
  DOMAIN: outputs.apiHost,
  PLATFORM_ENV: 'k8s',
  APP_DOMAIN: projectHostDomain,
  PROJECT_HOST_DOMAIN: projectHostDomain,
  PROJECT_HOST_SUFFIX: projectHostSuffix,
  PROJECT_DATABASE_PREFIX: projectDatabasePrefix,
  AWS_REGION: outputs.region,
  AWS_ACCOUNT_ID: outputs.accountId,
  ECR_REPO: resolvedCustomerAppRepositoryName,
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
  WORKSPACE_POD_NAMESPACE: developmentNamespace,
  WORKER_POD_NAMESPACE: platformNamespace,
  PLATFORM_NAMESPACE: platformNamespace,
  DEVELOPMENT_NAMESPACE: developmentNamespace,
  TESTING_NAMESPACE: testingNamespace,
  PRODUCTION_NAMESPACE: productionNamespace,
  RUNTIME_NAMESPACE_DEVELOPMENT: developmentNamespace,
  RUNTIME_NAMESPACE_TESTING: testingNamespace,
  RUNTIME_NAMESPACE_PRODUCTION: productionNamespace,
  WORKSPACE_STORAGE_SIZE: workerSecret.WORKSPACE_STORAGE_SIZE || '10Gi',
  WORKSPACE_IDLE_TTL_MS: workerSecret.WORKSPACE_IDLE_TTL_MS || '1200000',
  WORKSPACE_PREVIEW_START_TIMEOUT_MS: workerSecret.WORKSPACE_PREVIEW_START_TIMEOUT_MS || '120000',
  WORKSPACE_HEARTBEAT_STALE_MS: workerSecret.WORKSPACE_HEARTBEAT_STALE_MS || '120000',
  WORKSPACE_RECONCILE_INTERVAL_MS: workerSecret.WORKSPACE_RECONCILE_INTERVAL_MS || '60000',
  WORKSPACE_POD_CPU_REQUEST: workerSecret.WORKSPACE_POD_CPU_REQUEST || '200m',
  WORKSPACE_POD_CPU_LIMIT: workerSecret.WORKSPACE_POD_CPU_LIMIT || '1500m',
  WORKSPACE_POD_MEM_REQUEST: workerSecret.WORKSPACE_POD_MEM_REQUEST || '512Mi',
  WORKSPACE_POD_MEM_LIMIT: workerSecret.WORKSPACE_POD_MEM_LIMIT || '2Gi',
  WORKSPACE_STORAGE_CLASS: workerSecret.WORKSPACE_STORAGE_CLASS || liveWorkerEnv.WORKSPACE_STORAGE_CLASS || 'gp3',
  WORKSPACE_SNAPSHOT_BUCKET: outputs.workspaceSnapshotBucket,
  WORKSPACE_SNAPSHOT_PREFIX: outputs.workspaceSnapshotPrefix,
  DEV_SCALE_TO_ZERO_AFTER_MS: workerSecret.DEV_SCALE_TO_ZERO_AFTER_MS || '900000',
  TEST_SCALE_TO_ZERO_AFTER_MS: workerSecret.TEST_SCALE_TO_ZERO_AFTER_MS || '10800000',
  SCALE_TO_ZERO_INTERVAL_MS: workerSecret.SCALE_TO_ZERO_INTERVAL_MS || '60000',
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
  ALB_GROUP_ORDER: workerSecret.ALB_GROUP_ORDER || '50',
  PLATFORM_SERVER_NAME: platformServerName,
  PLATFORM_WEB_NAME: platformWebName,
  PLATFORM_WORKER_NAME: platformWorkerName,
  PLATFORM_REDIS_NAME: platformRedisName,
  PLATFORM_SERVER_SERVICE_ACCOUNT_NAME: platformServerServiceAccountName,
  PLATFORM_WORKER_SERVICE_ACCOUNT_NAME: platformWorkerServiceAccountName,
  PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME: platformServerMetricsClusterRoleName,
  PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME: platformServerMetricsClusterRoleBindingName,
  PLATFORM_WORKER_CLUSTER_ROLE_NAME: platformWorkerClusterRoleName,
  PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME: platformWorkerClusterRoleBindingName,
  PROJECT_WILDCARD_HOSTS: projectWildcardHosts,
  CODEX_COMMAND_TEMPLATE:
    'OPENAI_API_KEY="$OPENAI_API_KEY" codex exec --skip-git-repo-check --json -o "$CODEX_RESPONSE_FILE" --ephemeral -m "$OPENAI_MODEL" --dangerously-bypass-approvals-and-sandbox "$CODEX_PROMPT"',
  CODEX_COMMAND_TEMPLATE_RESUME:
    'OPENAI_API_KEY="$OPENAI_API_KEY" codex exec --skip-git-repo-check --json -o "$CODEX_RESPONSE_FILE" --ephemeral -m "$OPENAI_MODEL" --dangerously-bypass-approvals-and-sandbox resume "$CODEX_THREAD_ID" "$CODEX_PROMPT"'
};

const metadataEnv = {
  AWS_REGION: outputs.region,
  ACCOUNT_ID: outputs.accountId,
  CLUSTER_NAME: outputs.clusterName,
  ROOT_HOST: outputs.rootHost,
  APP_HOST: outputs.appHost,
  API_HOST: outputs.apiHost,
  ROUTE53_ZONE_ID: outputs.route53ZoneId,
  ACM_CERT_ARN: outputs.acmCertificateArn,
  ALB_GROUP_NAME: outputs.albGroupName,
  ALB_LOG_BUCKET: outputs.albLogBucket,
  ALB_LOG_PREFIX: outputs.albLogPrefix,
  SERVER_REPOSITORY_URL: resolvedServerRepositoryUrl,
  WEB_REPOSITORY_URL: resolvedWebRepositoryUrl,
  WORKER_REPOSITORY_URL: resolvedWorkerRepositoryUrl,
  CUSTOMER_APP_REPOSITORY_NAME: resolvedCustomerAppRepositoryName,
  WORKER_IRSA_ROLE_ARN: outputs.workerIrsaRoleArn,
  PLATFORM_NAMESPACE: platformNamespace,
  DEVELOPMENT_NAMESPACE: developmentNamespace,
  TESTING_NAMESPACE: testingNamespace,
  PRODUCTION_NAMESPACE: productionNamespace,
  PLATFORM_SERVER_NAME: platformServerName,
  PLATFORM_WEB_NAME: platformWebName,
  PLATFORM_WORKER_NAME: platformWorkerName,
  PLATFORM_REDIS_NAME: platformRedisName,
  PLATFORM_SERVER_SERVICE_ACCOUNT_NAME: platformServerServiceAccountName,
  PLATFORM_WORKER_SERVICE_ACCOUNT_NAME: platformWorkerServiceAccountName,
  PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME: platformServerMetricsClusterRoleName,
  PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME: platformServerMetricsClusterRoleBindingName,
  PLATFORM_WORKER_CLUSTER_ROLE_NAME: platformWorkerClusterRoleName,
  PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME: platformWorkerClusterRoleBindingName,
  PROJECT_HOST_DOMAIN: projectHostDomain,
  PROJECT_HOST_SUFFIX: projectHostSuffix,
  PROJECT_WILDCARD_HOSTS: projectWildcardHosts,
  PROJECT_DATABASE_PREFIX: projectDatabasePrefix
};

await Promise.all([
  fs.writeFile(path.join(outputDir, 'server.env'), formatEnv(serverEnv), 'utf8'),
  fs.writeFile(path.join(outputDir, 'web.env'), formatEnv(webEnv), 'utf8'),
  fs.writeFile(path.join(outputDir, 'worker.env'), formatEnv(workerEnv), 'utf8'),
  fs.writeFile(path.join(outputDir, 'metadata.env'), formatEnv(metadataEnv), 'utf8')
]);

console.log(`[replica] Wrote server.env, web.env, worker.env, and metadata.env into ${outputDir}`);
