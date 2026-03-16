#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const generatedDir = path.join(repoRoot, 'deploy', '.generated', 'replica', 'manual-secrets');
const terraformBin = process.env.TERRAFORM_BIN || path.join(repoRoot, 'scripts', 'replica', 'terraformw.sh');
const layer1Dir = process.env.LAYER1_DIR || path.join(repoRoot, 'infra', 'envs', 'test-replica', 'layer1');

function parseArgs(argv) {
  const result = { mode: 'plan' };
  for (const arg of argv) {
    if (arg === 'plan' || arg === 'apply') {
      result.mode = arg;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    result[rawKey] = rawValue ?? 'true';
  }
  return result;
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadEnvFile(filePath) {
  if (!(await fileExists(filePath))) return {};
  return parseEnv(await fs.readFile(filePath, 'utf8'));
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

function pick(env, keys) {
  const values = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key) && String(env[key]).trim() !== '') {
      values[key] = env[key];
    }
  }
  return values;
}

function maxNumericString(rawValue, floorValue) {
  const parsed = Number(String(rawValue || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return String(floorValue);
  }
  return String(Math.max(Math.floor(parsed), floorValue));
}

function required(payload, keys, label) {
  for (const key of keys) {
    if (!String(payload[key] || '').trim()) {
      throw new Error(`${label} is missing required key ${key}`);
    }
  }
}

function summarizePayload(payload) {
  return Object.keys(payload).sort();
}

async function secretExists(secretId) {
  try {
    await run('aws', ['secretsmanager', 'describe-secret', '--secret-id', secretId]);
    return true;
  } catch {
    return false;
  }
}

async function putSecretValue(secretId, jsonPath) {
  const secretString = await fs.readFile(jsonPath, 'utf8');
  await run('aws', [
    'secretsmanager',
    'put-secret-value',
    '--secret-id',
    secretId,
    '--secret-string',
    secretString
  ]);
}

const args = parseArgs(process.argv.slice(2));
const serverEnvPath = path.resolve(repoRoot, args['server-env'] || process.env.SERVER_ENV_FILE || '.env.server');
const workerEnvPath = path.resolve(repoRoot, args['worker-env'] || process.env.WORKER_ENV_FILE || '.env.worker');
const webEnvPath = path.resolve(repoRoot, args['web-env'] || process.env.WEB_ENV_FILE || '.env.web');

const serverSource = await loadEnvFile(serverEnvPath);
const workerSource = await loadEnvFile(workerEnvPath);
const webSource = await loadEnvFile(webEnvPath);

const mergedShared = {
  ...workerSource,
  ...serverSource
};

const rootHost = await resolveTerraformOrDefault(
  'root_host',
  `${process.env.REPLICA_SUBDOMAIN || 'replica'}.${process.env.REPLICA_ROOT_DOMAIN || 'vibesplatform.ai'}`
);

const serverSecretId = String(
  args.serverSecret ||
  process.env.REPLICA_SERVER_SECRET_NAME ||
  await resolveTerraformOrDefault('server_manual_secret_name', '/vibes/test-replica/server')
);
const webSecretId = String(
  args.webSecret ||
  process.env.REPLICA_WEB_SECRET_NAME ||
  await resolveTerraformOrDefault('web_manual_secret_name', '/vibes/test-replica/web')
);
const workerSecretId = String(
  args.workerSecret ||
  process.env.REPLICA_WORKER_SECRET_NAME ||
  await resolveTerraformOrDefault('worker_manual_secret_name', '/vibes/test-replica/worker')
);

const serverPayload = {
  OPENAI_API_KEY: serverSource.OPENAI_API_KEY || workerSource.OPENAI_API_KEY || '',
  OPENAI_MODEL: serverSource.OPENAI_MODEL || workerSource.OPENAI_MODEL || '',
  JWT_SECRET: serverSource.JWT_SECRET || '',
  ADMIN_API_KEY: serverSource.ADMIN_API_KEY || '',
  CORS_ORIGIN_EXTRA: serverSource.CORS_ORIGIN_EXTRA || 'tauri://localhost,http://localhost',
  UPGRADE_URL: webSource.UPGRADE_URL || `https://${rootHost}/pricing`,
  ...pick(serverSource, [
    'ALLOW_PASSWORD_BYPASS',
    'MAX_UPLOAD_MB',
    'DEFAULT_USER_PLAN',
    'RUNTIME_QUOTAS',
    'PLAN_LIMITS',
    'NODEGROUP_MONTHLY_COSTS',
    'DESKTOP_DOWNLOAD_DIR'
  ])
};

const webPayload = {
  UPGRADE_URL: webSource.UPGRADE_URL || serverPayload.UPGRADE_URL
};

const workerPayload = {
  OPENAI_API_KEY: workerSource.OPENAI_API_KEY || serverSource.OPENAI_API_KEY || '',
  OPENAI_MODEL: workerSource.OPENAI_MODEL || serverSource.OPENAI_MODEL || '',
  GIT_TOKEN: workerSource.GIT_TOKEN || '',
  STARTER_REPO_URL: workerSource.STARTER_REPO_URL || 'https://github.com/dscarlin/vibesplatform-starter-app.git',
  STARTER_REPO_REF: workerSource.STARTER_REPO_REF || 'main',
  ...pick(mergedShared, [
    'DELETE_ECR_IMAGES',
    'HEALTHCHECK_PATH',
    'HEALTHCHECK_TIMEOUT_MS',
    'HEALTHCHECK_INTERVAL_MS',
    'HEALTHCHECK_LOG_LINES',
    'EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS',
    'READINESS_PROBE_PERIOD_SECONDS',
    'READINESS_PROBE_TIMEOUT_SECONDS',
    'READINESS_PROBE_FAILURE_THRESHOLD',
    'READINESS_PROBE_SUCCESS_THRESHOLD',
    'STARTUP_PROBE_PERIOD_SECONDS',
    'STARTUP_PROBE_TIMEOUT_SECONDS',
    'STARTUP_PROBE_FAILURE_THRESHOLD',
    'ALB_HEALTHCHECK_INTERVAL_SECONDS',
    'ALB_HEALTHCHECK_TIMEOUT_SECONDS',
    'ALB_HEALTHY_THRESHOLD_COUNT',
    'ALB_UNHEALTHY_THRESHOLD_COUNT',
    'WORKSPACE_STORAGE_SIZE',
    'WORKSPACE_IDLE_TTL_MS',
    'WORKSPACE_PREVIEW_START_TIMEOUT_MS',
    'WORKSPACE_HEARTBEAT_STALE_MS',
    'WORKSPACE_RECONCILE_INTERVAL_MS',
    'WORKSPACE_POD_CPU_REQUEST',
    'WORKSPACE_POD_CPU_LIMIT',
    'WORKSPACE_POD_MEM_REQUEST',
    'WORKSPACE_POD_MEM_LIMIT',
    'DEV_SCALE_TO_ZERO_AFTER_MS',
    'TEST_SCALE_TO_ZERO_AFTER_MS',
    'SCALE_TO_ZERO_INTERVAL_MS',
    'RUNTIME_QUOTAS',
    'PLAN_LIMITS',
    'RUNTIME_QUOTA_INTERVAL_MS',
    'DEV_CPU_REQUEST',
    'DEV_CPU_LIMIT',
    'DEV_MEM_REQUEST',
    'DEV_MEM_LIMIT',
    'TEST_CPU_REQUEST',
    'TEST_CPU_LIMIT',
    'TEST_MEM_REQUEST',
    'TEST_MEM_LIMIT',
    'PROD_CPU_REQUEST',
    'PROD_CPU_LIMIT',
    'PROD_MEM_REQUEST',
    'PROD_MEM_LIMIT',
    'QUEUE_BACKLOG_THRESHOLD',
    'QUEUE_MONITOR_INTERVAL_MS',
    'ALERT_COOLDOWN_MS',
    'ALB_GROUP_ORDER'
  ])
};

workerPayload.EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS = maxNumericString(
  workerPayload.EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS,
  8
);

required(serverPayload, ['OPENAI_API_KEY', 'OPENAI_MODEL', 'JWT_SECRET', 'ADMIN_API_KEY'], serverEnvPath);
required(workerPayload, ['OPENAI_API_KEY', 'OPENAI_MODEL', 'GIT_TOKEN'], workerEnvPath);

await fs.mkdir(generatedDir, { recursive: true });

const serverJsonPath = path.join(generatedDir, 'server.json');
const webJsonPath = path.join(generatedDir, 'web.json');
const workerJsonPath = path.join(generatedDir, 'worker.json');

await Promise.all([
  fs.writeFile(serverJsonPath, `${JSON.stringify(serverPayload, null, 2)}\n`, 'utf8'),
  fs.writeFile(webJsonPath, `${JSON.stringify(webPayload, null, 2)}\n`, 'utf8'),
  fs.writeFile(workerJsonPath, `${JSON.stringify(workerPayload, null, 2)}\n`, 'utf8')
]);

console.log(`[replica] Seed source files:
- ${serverEnvPath}
- ${workerEnvPath}
- ${webEnvPath}`);

console.log(`[replica] Generated secret payloads:
- ${serverSecretId} <= ${serverJsonPath} (${summarizePayload(serverPayload).join(', ')})
- ${webSecretId} <= ${webJsonPath} (${summarizePayload(webPayload).join(', ')})
- ${workerSecretId} <= ${workerJsonPath} (${summarizePayload(workerPayload).join(', ')})`);

if (args.mode !== 'apply') {
  console.log('[replica] Plan only. No Secrets Manager values were changed.');
  process.exit(0);
}

for (const [secretId, jsonPath] of [
  [serverSecretId, serverJsonPath],
  [webSecretId, webJsonPath],
  [workerSecretId, workerJsonPath]
]) {
  if (!(await secretExists(secretId))) {
    throw new Error(`Secrets Manager secret ${secretId} does not exist. Run Layer 1 apply first.`);
  }
  await putSecretValue(secretId, jsonPath);
}

console.log('[replica] Secrets Manager values updated.');
