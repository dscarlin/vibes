import dotenv from 'dotenv';
import fsSync from 'fs';
import { Queue, Worker } from 'bullmq';
import pg from 'pg';
import os, { type } from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import tar from 'tar';
import { io as socketIoClient } from 'socket.io-client';
import crypto from 'crypto';
import zlib from 'zlib';
import readline from 'readline';

if (fsSync.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local', override: true });
}
dotenv.config({ override: true });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adminPool = new Pool({ connectionString: process.env.CUSTOMER_DB_ADMIN_URL });
const exec = promisify(execFile);

const SNAPSHOT_ARTIFACTS = new Set([
  'snapshot.tar.gz',
  'snapshot-updated.tar.gz',
  'deploy-snapshot.tar.gz'
]);
const SNAPSHOT_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'out',
  '.svelte-kit',
  '.astro',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage'
]);

function isSnapshotArtifact(entryPath) {
  if (!entryPath) return false;
  const normalized = entryPath.replace(/^\.\//, '');
  return SNAPSHOT_ARTIFACTS.has(normalized);
}

function isExcludedSnapshotPath(entryPath) {
  if (!entryPath) return false;
  const normalized = entryPath.replace(/^\.\//, '');
  if (isSnapshotArtifact(normalized)) return true;
  const parts = normalized.split('/');
  return parts.some((part) => SNAPSHOT_EXCLUDE_DIRS.has(part));
}

async function stripSnapshotArtifacts(repoPath) {
  await Promise.all(
    Array.from(SNAPSHOT_ARTIFACTS).map((name) =>
      fs.rm(path.join(repoPath, name), { force: true }).catch(() => {})
    )
  );
}

async function createSnapshotArchive(repoPath, namePrefix) {
  await stripSnapshotArtifacts(repoPath);
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-archive-'));
  const archivePath = path.join(archiveDir, `${namePrefix}.tar.gz`);
  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: repoPath,
      filter: (entryPath) => !isExcludedSnapshotPath(entryPath)
    },
    ['.']
  );
  return { archivePath, archiveDir };
}

async function createSnapshotBlob(repoPath, namePrefix) {
  const { archivePath, archiveDir } = await createSnapshotArchive(repoPath, namePrefix);
  const blob = await fs.readFile(archivePath);
  await fs.rm(archiveDir, { recursive: true, force: true });
  return blob;
}

async function hashFile(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseRuntimeQuotas(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parsePlanLimits(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePlanName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (['starter', 'builder', 'business', 'agency'].includes(normalized)) return normalized;
  return DEFAULT_USER_PLAN;
}

function runtimeQuotaMs(planName, environment) {
  const planKey = normalizePlanName(planName);
  const planLimits = RUNTIME_QUOTAS[planKey] || {};
  const envKey = String(environment || '').toLowerCase();
  const hoursRaw = planLimits[envKey];
  const hours = Number(hoursRaw);
  if (!hours || Number.isNaN(hours) || hours <= 0) return null;
  return hours * 60 * 60 * 1000;
}

function resolvePlanLimits(planName) {
  const planKey = normalizePlanName(planName);
  const defaults = PLAN_LIMIT_DEFAULTS[planKey] || {};
  const overrides = PLAN_LIMITS[planKey] || {};
  return { ...defaults, ...overrides };
}

async function getPlanForProject(projectId) {
  const result = await pool.query(
    `select u.plan as plan_name
     from projects p
     join users u on u.id = p.owner_id
     where p.id = $1`,
    [projectId]
  );
  const name = normalizePlanName(result.rows[0]?.plan_name || DEFAULT_USER_PLAN);
  return { name, limits: resolvePlanLimits(name) };
}

function currentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

async function getRuntimeUsageMsByUser(userId, environment) {
  try {
    const month = currentMonthKey();
    const usageRes = await pool.query(
      `select coalesce(sum(runtime_ms), 0)::bigint as runtime_ms
       from runtime_usage
       where user_id = $1 and environment = $2 and month = $3`,
      [userId, environment, month]
    );
    let totalMs = Number(usageRes.rows[0]?.runtime_ms || 0);
    const liveRes = await pool.query(
      `select e.live_since
       from environments e
       join projects p on p.id = e.project_id
       where p.owner_id = $1
         and e.name = $2
         and e.build_status = 'live'
         and e.live_since is not null`,
      [userId, environment]
    );
    const now = Date.now();
    for (const row of liveRes.rows) {
      const start = new Date(row.live_since).getTime();
      if (Number.isFinite(start) && now > start) {
        totalMs += now - start;
      }
    }
    return totalMs;
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('runtime_usage') || msg.includes('live_since')) return 0;
    throw err;
  }
}

function isPrivateIpv4(address) {
  if (!address) return false;
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  const match = address.match(/^172\.(\d+)\./);
  if (!match) return false;
  const octet = Number(match[1]);
  return octet >= 16 && octet <= 31;
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  let fallback = null;
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (isPrivateIpv4(addr.address)) {
        return addr.address;
      }
      if (!fallback) fallback = addr.address;
    }
  }
  return fallback;
}

const LOCAL_LAN_IP = getLocalLanIp();

async function resolveShell() {
  const candidates = [
    process.env.VIBES_SHELL,
    process.env.SHELL,
    '/bin/sh',
    '/usr/bin/sh',
    '/usr/local/bin/sh',
    '/bin/busybox',
    '/usr/local/bin/busybox'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const args = candidate.includes('busybox') ? ['sh', '-lc'] : ['-lc'];
      return { shell: candidate, args };
    } catch {
      // Try next candidate.
    }
  }
  return { shell: 'sh', args: ['-lc'] };
}

async function runCommandStreaming(command, env, options = {}) {
  const { shell, args } = await resolveShell();
  const buildId = options.buildId || null;
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, command], { env });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let flushTimer = null;
    let cancelTimer = null;
    let cancelRequested = false;

    const flush = async (force = false) => {
      if (!buildId) return;
      if (!force && !buffer) return;
      const chunk = buffer;
      buffer = '';
      if (chunk) {
        await appendBuildLog(buildId, chunk);
      }
    };

    const scheduleFlush = () => {
      if (!buildId || flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush().catch((err) => {
          console.warn('Failed to flush build log', err?.message || err);
        });
      }, BUILD_LOG_FLUSH_INTERVAL_MS);
    };

    const requestCancel = async () => {
      if (cancelRequested) return;
      cancelRequested = true;
      buffer += '\n\n[system] Build cancelled by user.\n';
      await flush(true);
      try {
        child.kill('SIGTERM');
      } catch { }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { }
      }, 5000);
    };

    if (buildId) {
      activeBuilds.set(buildId, { child, cancel: requestCancel });
      cancelTimer = setInterval(async () => {
        if (cancelRequested) return;
        if (await isCancelRequested(buildId)) {
          await requestCancel();
        }
      }, BUILD_CANCEL_POLL_INTERVAL_MS);
    }

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (buildId) {
        buffer += text;
        scheduleFlush();
      }
      process.stdout.write(text);
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (buildId) {
        buffer += text;
        scheduleFlush();
      }
      process.stderr.write(text);
    });
    child.on('error', (err) => {
      if (flushTimer) clearTimeout(flushTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (buildId) activeBuilds.delete(buildId);
      reject(err);
    });
    child.on('close', (code) => {
      (async () => {
        if (flushTimer) clearTimeout(flushTimer);
        if (cancelTimer) clearInterval(cancelTimer);
        if (buildId) activeBuilds.delete(buildId);
        await flush(true);
        if (cancelRequested) {
          const err = buildCancelError();
          err.stdout = stdout;
          err.stderr = stderr;
          throw err;
        }
        if (code && code !== 0) {
          const err = new Error(`Command exited with code ${code}`);
          err.stdout = stdout;
          err.stderr = stderr;
          throw err;
        }
        return { stdout, stderr };
      })()
        .then(resolve)
        .catch(reject);
    });
  });
}

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379)
};

const AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'Vibes AI';
const AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'ai@vibes.local';
const STARTER_REPO_URL = process.env.STARTER_REPO_URL;
const STARTER_REPO_REF = process.env.STARTER_REPO_REF || 'main';
const GIT_TOKEN = process.env.GIT_TOKEN || '';
const SOCKET_URL = process.env.SERVER_SOCKET_URL || 'http://localhost:8000';
const CUSTOMER_DB_HOST = process.env.CUSTOMER_DB_HOST || 'localhost';
const CUSTOMER_DB_PORT = Number(process.env.CUSTOMER_DB_PORT || 5432);
const CUSTOMER_DB_USER = process.env.CUSTOMER_DB_USER || 'app_user';
const CUSTOMER_DB_PASSWORD = process.env.CUSTOMER_DB_PASSWORD || '';
const CUSTOMER_DB_SSLMODE = process.env.CUSTOMER_DB_SSLMODE || 'disable';
const CUSTOMER_DB_SSLROOTCERT = process.env.CUSTOMER_DB_SSLROOTCERT || '';
const DEV_DEPLOY_COMMAND = process.env.DEV_DEPLOY_COMMAND;
const TEST_DEPLOY_COMMAND = process.env.TEST_DEPLOY_COMMAND;
const PROD_DEPLOY_COMMAND = process.env.PROD_DEPLOY_COMMAND;
const PLATFORM_ENV = process.env.PLATFORM_ENV || 'local';
const DEV_DELETE_COMMAND = process.env.DEV_DELETE_COMMAND;
const TEST_DELETE_COMMAND = process.env.TEST_DELETE_COMMAND;
const PROD_DELETE_COMMAND = process.env.PROD_DELETE_COMMAND;
const VIBES_WORKDIR_ROOT = process.env.VIBES_WORKDIR_ROOT || path.join(os.homedir(), '.vibes');
const LOCAL_PROJECT_REPO_ROOT = path.join(VIBES_WORKDIR_ROOT, 'repos');
const WORKSPACE_ROOT_PATH = process.env.WORKSPACE_ROOT_PATH || '/workspace/project';
const WORKSPACE_META_PATH = process.env.WORKSPACE_META_PATH || '/workspace/.vibes';
const WORKSPACE_STORAGE_SIZE = process.env.WORKSPACE_STORAGE_SIZE || '10Gi';
const WORKSPACE_STORAGE_CLASS = process.env.WORKSPACE_STORAGE_CLASS || '';
const WORKSPACE_IDLE_TTL_MS = Number(process.env.WORKSPACE_IDLE_TTL_MS || 20 * 60 * 1000);
const WORKSPACE_HEARTBEAT_STALE_MS = Number(process.env.WORKSPACE_HEARTBEAT_STALE_MS || 2 * 60 * 1000);
const WORKSPACE_SERVICE_PORT = Number(process.env.WORKSPACE_SERVICE_PORT || 3000);
const WORKSPACE_SERVICE_CLUSTER_PORT = Number(process.env.WORKSPACE_SERVICE_CLUSTER_PORT || 80);
const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE || '';
const WORKSPACE_POD_NAMESPACE = process.env.WORKSPACE_POD_NAMESPACE || 'vibes-platform';
const WORKSPACE_POD_CPU_REQUEST = process.env.WORKSPACE_POD_CPU_REQUEST || '200m';
const WORKSPACE_POD_CPU_LIMIT = process.env.WORKSPACE_POD_CPU_LIMIT || '1500m';
const WORKSPACE_POD_MEM_REQUEST = process.env.WORKSPACE_POD_MEM_REQUEST || '512Mi';
const WORKSPACE_POD_MEM_LIMIT = process.env.WORKSPACE_POD_MEM_LIMIT || '2Gi';
const CUSTOMER_NODEGROUP_ENABLED = String(process.env.CUSTOMER_NODEGROUP_ENABLED || '').trim().toLowerCase() === 'true';
const CUSTOMER_NODEGROUP_LABEL = String(process.env.CUSTOMER_NODEGROUP_LABEL || 'nodegroup').trim() || 'nodegroup';
const CUSTOMER_NODEGROUP_VALUE = String(process.env.CUSTOMER_NODEGROUP_VALUE || 'customer').trim() || 'customer';
const CUSTOMER_NODEGROUP_TAINT_KEY =
  String(process.env.CUSTOMER_NODEGROUP_TAINT_KEY || 'nodegroup').trim() || 'nodegroup';
const CUSTOMER_NODEGROUP_TAINT_VALUE =
  String(process.env.CUSTOMER_NODEGROUP_TAINT_VALUE || 'customer').trim() || 'customer';
const WORKSPACE_SNAPSHOT_BUCKET = process.env.WORKSPACE_SNAPSHOT_BUCKET || '';
const WORKSPACE_SNAPSHOT_PREFIX = process.env.WORKSPACE_SNAPSHOT_PREFIX || 'project-workspaces';
const WORKSPACE_PREVIEW_START_TIMEOUT_MS = Number(process.env.WORKSPACE_PREVIEW_START_TIMEOUT_MS || 120000);
const WORKSPACE_RECONCILE_INTERVAL_MS = Number(process.env.WORKSPACE_RECONCILE_INTERVAL_MS || 60000);
const DEMO_MODE = (process.env.DEMO_MODE || '').toLowerCase() === 'true';
const HEALTHCHECK_DEFAULTS = {
  path: process.env.HEALTHCHECK_PATH || '/',
  pathDev: process.env.HEALTHCHECK_PATH_DEV || '',
  pathTest: process.env.HEALTHCHECK_PATH_TEST || '',
  pathProd: process.env.HEALTHCHECK_PATH_PROD || '',
  protocol: process.env.HEALTHCHECK_PROTOCOL || '',
  protocolDev: process.env.HEALTHCHECK_PROTOCOL_DEV || '',
  protocolTest: process.env.HEALTHCHECK_PROTOCOL_TEST || '',
  protocolProd: process.env.HEALTHCHECK_PROTOCOL_PROD || '',
  timeoutMs: Number(process.env.HEALTHCHECK_TIMEOUT_MS || 60000),
  intervalMs: Number(process.env.HEALTHCHECK_INTERVAL_MS || 3000)
};
const DEV_RUNTIME_MODE = String(process.env.DEV_RUNTIME_MODE || 'pod').trim().toLowerCase();
const DEPLOY_HEALTH_TARGET = String(process.env.DEPLOY_HEALTH_TARGET || 'public').trim().toLowerCase();
const EXTERNAL_HEALTHCHECK_TIMEOUT_MS = Number(
  process.env.EXTERNAL_HEALTHCHECK_TIMEOUT_MS || Math.max(HEALTHCHECK_DEFAULTS.timeoutMs, 120000)
);
const POD_READINESS_POLL_MS = Math.max(1000, Number(process.env.POD_READINESS_POLL_MS || 2000));
const EXTERNAL_HEALTHCHECK_POLL_AFTER_READY_MS = Math.max(
  1000,
  Number(process.env.EXTERNAL_HEALTHCHECK_POLL_AFTER_READY_MS || 6000)
);
const EXTERNAL_HEALTHCHECK_POLL_BACKOFF_MS = Math.max(
  EXTERNAL_HEALTHCHECK_POLL_AFTER_READY_MS,
  Number(process.env.EXTERNAL_HEALTHCHECK_POLL_BACKOFF_MS || 12000)
);
const EXTERNAL_HEALTHCHECK_POLL_BACKOFF_AFTER_MS = Math.max(
  10000,
  Number(process.env.EXTERNAL_HEALTHCHECK_POLL_BACKOFF_AFTER_MS || 60000)
);
const EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS || 2)
);
const HEALTHCHECK_LOG_LINES = Math.max(50, Math.min(Number(process.env.HEALTHCHECK_LOG_LINES || 1200), 2000));
const CRASHLOOP_RESTART_THRESHOLD = Number(process.env.CRASHLOOP_RESTART_THRESHOLD || 5);
const DEV_SCALE_TO_ZERO_AFTER_MS = Number(process.env.DEV_SCALE_TO_ZERO_AFTER_MS || 15 * 60 * 1000);
const TEST_SCALE_TO_ZERO_AFTER_MS = Number(process.env.TEST_SCALE_TO_ZERO_AFTER_MS || 3 * 60 * 60 * 1000);
const SCALE_TO_ZERO_INTERVAL_MS = Number(process.env.SCALE_TO_ZERO_INTERVAL_MS || 60000);
const DEV_CRASH_HARD_ENABLED = String(process.env.DEV_CRASH_HARD_ENABLED || 'true').toLowerCase() !== 'false';
const DEV_CRASH_HARD_INTERVAL_MS = Math.max(5000, Number(process.env.DEV_CRASH_HARD_INTERVAL_MS || 15000));
const RUNTIME_QUOTA_INTERVAL_MS = Number(process.env.RUNTIME_QUOTA_INTERVAL_MS || 60000);
const DEFAULT_USER_PLAN = process.env.DEFAULT_USER_PLAN || 'starter';
const RUNTIME_QUOTAS = parseRuntimeQuotas(process.env.RUNTIME_QUOTAS || process.env.RUNTIME_QUOTAS_JSON || '');
const PLAN_LIMITS = parsePlanLimits(process.env.PLAN_LIMITS || process.env.PLAN_LIMITS_JSON || '');
const PLAN_LIMIT_DEFAULTS = {
  starter: { builds: 60, db_storage_gb: 2, bandwidth_gb: 15 },
  builder: { builds: 160, db_storage_gb: 8, bandwidth_gb: 50 },
  business: { builds: 500, db_storage_gb: 40, bandwidth_gb: 250 },
  agency: { builds: 2000, db_storage_gb: 200, bandwidth_gb: 1000 }
};
const BUILD_RECONCILE_STALE_MS = Number(
  process.env.BUILD_RECONCILE_STALE_MS || (HEALTHCHECK_DEFAULTS.timeoutMs + 60000)
);
const BUILD_RECONCILE_INTERVAL_MS = Number(process.env.BUILD_RECONCILE_INTERVAL_MS || 30000);
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const ALERT_SLACK_WEBHOOK_URL = process.env.ALERT_SLACK_WEBHOOK_URL || '';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 10 * 60 * 1000);
const QUEUE_BACKLOG_THRESHOLD = Number(process.env.QUEUE_BACKLOG_THRESHOLD || 5);
const QUEUE_MONITOR_INTERVAL_MS = Number(process.env.QUEUE_MONITOR_INTERVAL_MS || 60000);
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2));
const WORKSPACE_AUTO_VERIFY_DELAY_MS = Math.max(
  0,
  Number(process.env.WORKSPACE_AUTO_VERIFY_DELAY_MS || 45000)
);
const ALERT_RETENTION_DAYS = Number(process.env.ALERT_RETENTION_DAYS || 30);
const ALERT_RETENTION_INTERVAL_MS = Number(process.env.ALERT_RETENTION_INTERVAL_MS || 24 * 60 * 60 * 1000);
const DEPLOY_WEBHOOK_TIMEOUT_MS = Number(process.env.DEPLOY_WEBHOOK_TIMEOUT_MS || 8000);
const HEALTHCHECK_FAST_FAIL_WINDOW_MS = Number(process.env.HEALTHCHECK_FAST_FAIL_WINDOW_MS || 60000);
const HEALTHCHECK_FAST_FAIL_RESTARTS = Number(process.env.HEALTHCHECK_FAST_FAIL_RESTARTS || 1);
const HEALTHCHECK_FAST_FAIL_POLL_MS = Number(process.env.HEALTHCHECK_FAST_FAIL_POLL_MS || 60000);
const ALB_LOG_BUCKET = process.env.ALB_LOG_BUCKET || '';
const ALB_LOG_PREFIX = process.env.ALB_LOG_PREFIX || '';
const ALB_LOG_REGION = process.env.ALB_LOG_REGION || process.env.AWS_REGION || 'us-east-1';
const ALB_LOG_LOOKBACK_HOURS = Number(process.env.ALB_LOG_LOOKBACK_HOURS || 72);
const ALB_LOG_MAX_FILES = Number(process.env.ALB_LOG_MAX_FILES || 500);
const ALB_LOG_INGEST_INTERVAL_MS = Number(process.env.ALB_LOG_INGEST_INTERVAL_MS || 10 * 60 * 1000);
const BANDWIDTH_RECONCILE_INTERVAL_MS = Number(
  process.env.BANDWIDTH_RECONCILE_INTERVAL_MS || ALB_LOG_INGEST_INTERVAL_MS
);
const BUILD_LOG_FLUSH_INTERVAL_MS = Number(process.env.BUILD_LOG_FLUSH_INTERVAL_MS || 1500);
const BUILD_LOG_MAX_BYTES = Number(process.env.BUILD_LOG_MAX_BYTES || 2_000_000);
const BUILD_CANCEL_POLL_INTERVAL_MS = Number(process.env.BUILD_CANCEL_POLL_INTERVAL_MS || 2000);
const RUNTIME_LOG_CAPTURE_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.RUNTIME_LOG_CAPTURE_INTERVAL_MS || 4000)
);
const RUNTIME_LOG_CAPTURE_LINES = Math.max(
  200,
  Math.min(Number(process.env.RUNTIME_LOG_CAPTURE_LINES || 1200), 4000)
);
const RUNTIME_LOG_PREVIOUS_TAIL_LINES = Math.max(
  50,
  Math.min(Number(process.env.RUNTIME_LOG_PREVIOUS_TAIL_LINES || 500), 2000)
);
const RUNTIME_LOG_MAX_BYTES = Math.max(100_000, Number(process.env.RUNTIME_LOG_MAX_BYTES || 2_000_000));
const INCLUDE_RUNTIME_FAILURE_BOUNDARY_LOGS =
  String(process.env.INCLUDE_RUNTIME_FAILURE_BOUNDARY_LOGS || 'false').toLowerCase() === 'true';

export const taskQueue = new Queue('tasks', { connection });
const alertLastSentAt = new Map();
const activeBuilds = new Map();
const runtimeLogStreamState = new Map();

function alertKey(type, scope) {
  return `${type}:${scope || 'global'}`;
}

function shouldSendAlert(type, scope) {
  const key = alertKey(type, scope);
  const lastSent = alertLastSentAt.get(key) || 0;
  if (Date.now() - lastSent < ALERT_COOLDOWN_MS) return false;
  alertLastSentAt.set(key, Date.now());
  return true;
}

function truncateText(text, limit = 3500) {
  if (!text) return '';
  const value = String(text);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function buildCancelError() {
  const err = new Error('Build cancelled by user');
  err.code = 'build_cancelled';
  return err;
}

function buildLogFromError(err) {
  const output = `${err?.stdout || ''}${err?.stderr || ''}`.trim();
  return output || err?.message || 'Deploy failed';
}

async function isCancelRequested(buildId) {
  if (!buildId) return false;
  try {
    const res = await pool.query('select cancel_requested from builds where id = $1', [buildId]);
    return Boolean(res.rows[0]?.cancel_requested);
  } catch (err) {
    console.warn('Failed to check cancel status', err?.message || err);
    return false;
  }
}

async function appendBuildLog(buildId, chunk) {
  if (!buildId || !chunk) return;
  const payload = String(chunk);
  if (!payload) return;
  try {
    await pool.query(
      `update builds
       set build_log = case
         when build_log is null then $1
         when length(build_log) + length($1) > $2 then right(build_log || $1, $2)
         else build_log || $1
       end,
       updated_at = now()
       where id = $3`,
      [payload, BUILD_LOG_MAX_BYTES, buildId]
    );
  } catch (err) {
    console.warn('Failed to append build log', err?.message || err);
  }
}

function runtimeLogStorageUnsupported(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('latest_runtime_log');
}

function runtimeLogKey(projectId, environment) {
  return `${projectId}:${environment}`;
}

function projectLockKey(projectId) {
  const digest = crypto.createHash('sha1').update(String(projectId || '')).digest();
  return digest.readBigInt64BE(0).toString();
}

async function withProjectLock(projectId, fn) {
  const client = await pool.connect();
  const key = projectLockKey(projectId);
  try {
    await client.query('select pg_advisory_lock($1::bigint)', [key]);
    return await fn();
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1::bigint)', [key]);
    } catch (err) {
      console.warn(`Failed to release project lock for ${projectId}`, err?.message || err);
    }
    client.release();
  }
}

async function resolveJobProjectId(job) {
  if (job?.data?.projectId) return job.data.projectId;
  if (job?.name === 'codex-task' && job.data?.taskId) {
    const result = await pool.query('select project_id from tasks where id = $1', [job.data.taskId]);
    return result.rows[0]?.project_id || null;
  }
  if (job?.name === 'save-session' && job.data?.sessionId) {
    const result = await pool.query('select project_id from sessions where id = $1', [job.data.sessionId]);
    return result.rows[0]?.project_id || null;
  }
  return null;
}

function clearRuntimeLogStreamState(projectId, environment) {
  runtimeLogStreamState.delete(runtimeLogKey(projectId, environment));
}

async function resetLatestRuntimeLog(projectId, environment, attemptId = null) {
  clearRuntimeLogStreamState(projectId, environment);
  try {
    await pool.query(
      `update environments
       set latest_runtime_log = '',
           latest_runtime_log_updated_at = now(),
           latest_runtime_log_attempt_id = $3
       where project_id = $1
         and name = $2`,
      [projectId, environment, attemptId]
    );
  } catch (err) {
    if (runtimeLogStorageUnsupported(err)) return;
    console.warn('Failed to reset latest runtime log', err?.message || err);
  }
}

async function appendLatestRuntimeLog(projectId, environment, chunk, attemptId = null) {
  if (!chunk) return;
  const payload = String(chunk).replace(/\r/g, '');
  if (!payload) return;
  try {
    await pool.query(
      `update environments
       set latest_runtime_log = case
             when latest_runtime_log is null then right($4, $5)
             when length(latest_runtime_log) + length($4) > $5
               then right(latest_runtime_log || $4, $5)
             else latest_runtime_log || $4
           end,
           latest_runtime_log_updated_at = now(),
           latest_runtime_log_attempt_id = coalesce($3::uuid, latest_runtime_log_attempt_id)
       where project_id = $1
         and name = $2
         and ($3::uuid is null or latest_runtime_log_attempt_id = $3::uuid or latest_runtime_log_attempt_id is null)`,
      [projectId, environment, attemptId, payload, RUNTIME_LOG_MAX_BYTES]
    );
  } catch (err) {
    if (runtimeLogStorageUnsupported(err)) return;
    console.warn('Failed to append latest runtime log', err?.message || err);
  }
}

async function beginLatestRuntimeLogAttempt(projectId, environment, attemptId) {
  await resetLatestRuntimeLog(projectId, environment, attemptId || null);
  const startLine = `[system] Deploy attempt started at ${new Date().toISOString()}${attemptId ? ` (build ${attemptId})` : ''}\n`;
  await appendLatestRuntimeLog(projectId, environment, startLine, attemptId || null);
}

async function requestBuildCancel(buildId) {
  if (!buildId) return false;
  try {
    await pool.query(
      `update builds
       set cancel_requested = true,
           build_log = coalesce(build_log, '') || $1,
           updated_at = now()
       where id = $2`,
      ['\n\n[system] Cancel requested by user.\n', buildId]
    );
  } catch (err) {
    console.warn('Failed to set cancel flag', err?.message || err);
  }
  const active = activeBuilds.get(buildId);
  if (active?.cancel) {
    try {
      await active.cancel();
    } catch (err) {
      console.warn('Failed to cancel active build process', err?.message || err);
    }
  }
  return true;
}

async function ensureBuildNotCancelled(buildId) {
  if (!buildId) return;
  if (await isCancelRequested(buildId)) {
    throw buildCancelError();
  }
}

async function postWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn('Alert webhook failed', err?.message || err);
  }
}

async function recordAdminAlert(type, message, data, level = 'warning') {
  try {
    await pool.query(
      `insert into admin_alerts (type, level, message, data)
       values ($1, $2, $3, $4)`,
      [type, level, message, data || {}]
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (!msg.includes('admin_alerts')) {
      console.warn('Failed to record admin alert', err?.message || err);
    }
  }
}

function alertLevelFor(type) {
  if (type === 'healthcheck_failed') return 'error';
  if (type === 'dev_restart_hard_fail') return 'error';
  if (type === 'project_delete_cleanup_failed') return 'error';
  if (type === 'queue_backlog') return 'warning';
  return 'warning';
}

function normalizeAlertData(data) {
  const safe = { ...(data || {}) };
  if (!safe.summary && safe.detail) safe.summary = safe.detail;
  return safe;
}

async function sendAlert(type, message, data = {}, scope = '') {
  const hasWebhook = ALERT_WEBHOOK_URL || ALERT_SLACK_WEBHOOK_URL;
  if (!shouldSendAlert(type, scope)) return;
  const level = alertLevelFor(type);
  const payloadData = normalizeAlertData(data);
  if (hasWebhook) {
    const payload = {
      type,
      message,
      level,
      timestamp: new Date().toISOString(),
      data: payloadData
    };
    if (ALERT_WEBHOOK_URL) {
      await postWebhook(ALERT_WEBHOOK_URL, payload);
    }
    if (ALERT_SLACK_WEBHOOK_URL) {
      const slackText = [
        `*Vibes ${level === 'error' ? 'Error' : 'Alert'}:* ${message}`,
        payloadData?.project_id ? `Project: ${payloadData.project_id}` : '',
        payloadData?.environment ? `Env: ${payloadData.environment}` : '',
        payloadData?.host ? `Host: ${payloadData.host}` : '',
        payloadData?.commit ? `Commit: ${payloadData.commit}` : '',
        payloadData?.summary ? `Details: ${payloadData.summary}` : ''
      ]
        .filter(Boolean)
        .join('\n');
      await postWebhook(ALERT_SLACK_WEBHOOK_URL, { text: slackText });
    }
  }
  await recordAdminAlert(type, message, payloadData, level);
}

async function postJsonWithTimeout(url, payload, timeoutMs = DEPLOY_WEBHOOK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendDeployWebhook(projectId, environment, status, commitHash, buildId, detail = '') {
  try {
    const projectRes = await pool.query(
      'select name, short_id, project_slug, deploy_webhook_url from projects where id = $1',
      [projectId]
    );
    const project = projectRes.rows[0];
    const url = project?.deploy_webhook_url || '';
    if (!url) return;
    const payload = {
      type: status === 'live' ? 'deploy_success' : 'deploy_failed',
      status,
      project_id: projectId,
      environment,
      commit: commitHash || '',
      build_id: buildId,
      host: hostFor(project, environment),
      timestamp: new Date().toISOString(),
      detail: truncateText(detail || '', 3500)
    };
    await postJsonWithTimeout(url, payload);
  } catch (err) {
    console.warn('Deploy webhook failed', err?.message || err);
  }
}

async function syncDemoModeSetting() {
  try {
    await pool.query(
      `insert into settings (key, value)
       values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      ['demo_mode', DEMO_MODE ? 'true' : 'false']
    );
  } catch (err) {
    console.error('Failed to sync demo mode setting', err);
  }
}

async function ensureDeploymentPolicyDefault() {
  try {
    await pool.query(
      `insert into settings (key, value)
       values ($1, $2)
       on conflict (key) do nothing`,
      ['verified_only_deploys', 'false']
    );
  } catch (err) {
    console.error('Failed to ensure deployment policy default', err);
  }
}

function parseBooleanSetting(value, fallback = false) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off', ''].includes(raw)) return false;
  return fallback;
}

async function isVerifiedOnlyDeploysEnabled() {
  try {
    const result = await pool.query('select value from settings where key = $1', ['verified_only_deploys']);
    return parseBooleanSetting(result.rows[0]?.value, false);
  } catch (err) {
    console.warn('Failed to read deployment policy; defaulting to hot sync enabled', err?.message || err);
    return false;
  }
}

async function getDemoOpenAiKey(projectId) {
  if (!DEMO_MODE) return '';
  const fallbackKey = String(
    process.env.DEMO_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ''
  ).trim();
  const result = await pool.query(
    `select u.openai_api_key
     from users u
     join projects p on p.owner_id = u.id
     where p.id = $1`,
    [projectId]
  );
  return String(result.rows[0]?.openai_api_key || '').trim() || fallbackKey;
}

(async () => {
  await syncDemoModeSetting();
  await ensureDeploymentPolicyDefault();
})();

function dbNameFor(shortId, environment) {
  const safe = `${shortId}-${environment}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `vibes_${safe}`;
}

function dbUrlFor(dbName) {
  if (CUSTOMER_DB_SSLMODE !== 'disable' && !CUSTOMER_DB_SSLROOTCERT) {
    throw new Error('CUSTOMER_DB_SSLROOTCERT is required when CUSTOMER_DB_SSLMODE is not disable');
  }
  const auth = `${encodeURIComponent(CUSTOMER_DB_USER)}:${encodeURIComponent(CUSTOMER_DB_PASSWORD)}`;
  const params = new URLSearchParams();
  params.set('sslmode', CUSTOMER_DB_SSLMODE);
  if (CUSTOMER_DB_SSLROOTCERT) params.set('sslrootcert', CUSTOMER_DB_SSLROOTCERT);
  return `postgresql://${auth}@${CUSTOMER_DB_HOST}:${CUSTOMER_DB_PORT}/${dbName}?${params.toString()}`;
}

function dbUrlMatchesConfig(dbUrl) {
  if (!dbUrl) return false;
  try {
    const url = new URL(dbUrl);
    if (CUSTOMER_DB_HOST && url.hostname !== CUSTOMER_DB_HOST) return false;
    if (CUSTOMER_DB_PORT && Number(url.port || 5432) !== Number(CUSTOMER_DB_PORT)) return false;
    if (CUSTOMER_DB_USER && decodeURIComponent(url.username) !== CUSTOMER_DB_USER) return false;
    if (CUSTOMER_DB_PASSWORD && decodeURIComponent(url.password) !== CUSTOMER_DB_PASSWORD) return false;
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabase(dbName) {
  const exists = await adminPool.query('select 1 from pg_database where datname = $1', [dbName]);
  if (exists.rowCount > 0) return;
  await adminPool.query(`create database ${dbName}`);
}

async function dropDatabase(dbName) {
  await adminPool.query(
    `select pg_terminate_backend(pid)
     from pg_stat_activity
     where datname = $1 and pid <> pg_backend_pid()`,
    [dbName]
  );
  await adminPool.query(`drop database if exists ${dbName}`);
}

async function resetDatabase(dbName) {
  await adminPool.query(
    `select pg_terminate_backend(pid)
     from pg_stat_activity
     where datname = $1 and pid <> pg_backend_pid()`,
    [dbName]
  );
  await adminPool.query(`drop database if exists ${dbName}`);
  await adminPool.query(`create database ${dbName}`);
}

function healthcheckPathForEnv(environment) {
  if (environment === 'development' && HEALTHCHECK_DEFAULTS.pathDev) return HEALTHCHECK_DEFAULTS.pathDev;
  if (environment === 'testing' && HEALTHCHECK_DEFAULTS.pathTest) return HEALTHCHECK_DEFAULTS.pathTest;
  if (environment === 'production' && HEALTHCHECK_DEFAULTS.pathProd) return HEALTHCHECK_DEFAULTS.pathProd;
  return HEALTHCHECK_DEFAULTS.path;
}

function isLocalPlatform() {
  return PLATFORM_ENV === 'local';
}

function usesDevPodRuntime(environment) {
  if (isLocalPlatform()) return false;
  return String(environment || '').toLowerCase() === 'development' && DEV_RUNTIME_MODE !== 'deployment';
}

function healthcheckProtocolForEnv(environment) {
  if (isLocalPlatform()) return 'http';
  if (environment === 'development' && HEALTHCHECK_DEFAULTS.protocolDev) return HEALTHCHECK_DEFAULTS.protocolDev;
  if (environment === 'testing' && HEALTHCHECK_DEFAULTS.protocolTest) return HEALTHCHECK_DEFAULTS.protocolTest;
  if (environment === 'production' && HEALTHCHECK_DEFAULTS.protocolProd) return HEALTHCHECK_DEFAULTS.protocolProd;
  return HEALTHCHECK_DEFAULTS.protocol || 'https';
}

function healthcheckProtocolForHost(environment, host) {
  if (host.endsWith('.svc.cluster.local')) return 'http';
  return healthcheckProtocolForEnv(environment);
}

function healthcheckUrl(environment, host) {
  const protocol = healthcheckProtocolForHost(environment, host);
  const path = healthcheckPathForEnv(environment);
  return `${protocol}://${host}${path}`;
}

function deploymentHealthHost(environment, host, internalHost) {
  if (isLocalPlatform()) return host;
  if (DEPLOY_HEALTH_TARGET === 'internal' && environment !== 'production') return internalHost;
  return host;
}

function healthTimeoutForHost(host) {
  if (host.endsWith('.svc.cluster.local')) return HEALTHCHECK_DEFAULTS.timeoutMs;
  return Math.max(HEALTHCHECK_DEFAULTS.timeoutMs, EXTERNAL_HEALTHCHECK_TIMEOUT_MS);
}

function healthcheckDelayForElapsed(elapsedMs) {
  const base = Math.max(500, Number(HEALTHCHECK_DEFAULTS.intervalMs || 3000));
  const stage1 = base * 15; // ~45s when base=3s
  const stage2 = base * 40; // ~120s when base=3s
  if (elapsedMs < stage1) return base * 2;
  if (elapsedMs < stage2) return base;
  return base * 5;
}

function podReadinessDelayForElapsed(elapsedMs) {
  if (elapsedMs < 60_000) return POD_READINESS_POLL_MS;
  return Math.max(POD_READINESS_POLL_MS, 3000);
}

function externalHealthcheckDelayForReadyElapsed(readyElapsedMs) {
  if (readyElapsedMs < EXTERNAL_HEALTHCHECK_POLL_BACKOFF_AFTER_MS) {
    return EXTERNAL_HEALTHCHECK_POLL_AFTER_READY_MS;
  }
  return EXTERNAL_HEALTHCHECK_POLL_BACKOFF_MS;
}

function splitLogLines(text) {
  if (!text) return [];
  return String(text).replace(/\r/g, '').split('\n');
}

function computeLogDelta(previous, current) {
  const prev = String(previous || '').replace(/\r/g, '');
  const next = String(current || '').replace(/\r/g, '');
  if (!next) return { lines: [], reset: false };
  if (!prev) return { lines: splitLogLines(next), reset: false };
  if (prev === next) return { lines: [], reset: false };

  if (next.startsWith(prev)) {
    const deltaRaw = next.slice(prev.length).replace(/^\n/, '');
    return { lines: splitLogLines(deltaRaw), reset: false };
  }

  const prevLines = splitLogLines(prev);
  const nextLines = splitLogLines(next);
  const maxOverlap = Math.min(prevLines.length, nextLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (prevLines[prevLines.length - overlap + i] !== nextLines[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return { lines: nextLines.slice(overlap), reset: false };
    }
  }

  return { lines: nextLines, reset: true };
}

async function fetchPodsForApp(projectId, environment) {
  const namespace = `vibes-${environment}`;
  const appName = `vibes-app-${projectId}`;
  const { stdout } = await exec('sh', ['-lc', `kubectl -n ${namespace} get pods -l app=${appName} -o json`]);
  const data = JSON.parse(stdout || '{}');
  return Array.isArray(data.items) ? data.items : [];
}

function classifyRuntimeFailure({ reason = '', detail = '', exitCode = null, podReason = '', podMessage = '' } = {}) {
  const normalizedReason = String(reason || podReason || '').trim();
  const reasonUpper = normalizedReason.toUpperCase();
  const text = `${normalizedReason} ${detail || ''} ${podReason || ''} ${podMessage || ''}`.toLowerCase();
  const hasText = (pattern) => pattern.test(text);

  if (
    reasonUpper === 'EVICTED' ||
    reasonUpper === 'NODELOST' ||
    reasonUpper === 'PREEMPTED' ||
    reasonUpper === 'TERMINATED' ||
    hasText(/evicted|node lost|node was low on|preempt|spot interruption|disruption|drain/i)
  ) {
    return {
      category: 'platform_disruption',
      label: 'Cluster disruption',
      reason: normalizedReason || 'PlatformDisruption'
    };
  }

  if (
    reasonUpper === 'FAILEDMOUNT' ||
    reasonUpper === 'FAILEDSCHEDULING' ||
    reasonUpper === 'IMAGEPULLBACKOFF' ||
    reasonUpper === 'ERRIMAGEPULL' ||
    reasonUpper === 'CREATECONTAINERCONFIGERROR' ||
    reasonUpper === 'INVALIDIMAGENAME' ||
    reasonUpper === 'RUNCONTAINERERROR' ||
    hasText(/failed scheduling|failed mount|image pull|imagepullbackoff|errimagepull/i)
  ) {
    return {
      category: 'platform_configuration',
      label: 'Platform/runtime configuration',
      reason: normalizedReason || 'PlatformConfiguration'
    };
  }

  if (reasonUpper === 'OOMKILLED' || hasText(/oomkilled|out of memory|oom/i)) {
    return {
      category: 'resource_limit',
      label: 'Resource limit / OOM',
      reason: normalizedReason || 'OOMKilled'
    };
  }

  if (
    reasonUpper === 'PODFAILED' ||
    reasonUpper === 'CONTAINERRESTARTEDBEFOREHEALTHY' ||
    reasonUpper === 'CRASHLOOPBACKOFF' ||
    reasonUpper === 'ERROR' ||
    reasonUpper === 'CONTAINERCANNOTRUN' ||
    reasonUpper === 'STARTERROR' ||
    (Number.isFinite(exitCode) && Number(exitCode) !== 0)
  ) {
    return {
      category: 'app_failure',
      label: 'Application crash',
      reason: normalizedReason || (Number.isFinite(exitCode) ? `ExitCode${exitCode}` : 'AppFailure')
    };
  }

  return {
    category: 'unknown',
    label: 'Unknown failure cause',
    reason: normalizedReason || 'Unknown'
  };
}

function formatFailureClassification(classification) {
  if (!classification) return '';
  return `Failure classification: ${classification.label} (${classification.category})`;
}

function buildFastFail({ reason = '', message = '', detail = '', exitCode = null, podReason = '', podMessage = '' } = {}) {
  const classification = classifyRuntimeFailure({ reason, detail, exitCode, podReason, podMessage });
  return {
    reason,
    message,
    detail,
    exitCode,
    classification
  };
}

function analyzePodsForHealth(projectId, environment, pods) {
  let ready = false;
  let fastFail = null;
  let crashloop = null;
  let newestPodName = '';
  let newestPodTimestamp = 0;
  let newestPodReady = false;
  for (const pod of pods) {
    const podName = pod.metadata?.name || 'unknown';
    const podTimestamp = new Date(
      pod.status?.startTime || pod.metadata?.creationTimestamp || 0
    ).getTime() || 0;
    const phase = pod.status?.phase || '';
    const podReason = pod.status?.reason || '';
    const podMessage = pod.status?.message || '';
    const containerStatuses = pod.status?.containerStatuses || [];
    const statuses = [
      ...(pod.status?.initContainerStatuses || []),
      ...containerStatuses
    ];
    const readyCondition = Array.isArray(pod.status?.conditions)
      ? pod.status.conditions.find((condition) => condition.type === 'Ready')
      : null;
    const podReady =
      readyCondition?.status === 'True' &&
      containerStatuses.length > 0 &&
      containerStatuses.every((status) => status?.ready);
    if (podReady) ready = true;
    if (podTimestamp >= newestPodTimestamp) {
      newestPodTimestamp = podTimestamp;
      newestPodName = podName;
      newestPodReady = podReady;
    }

    for (const status of statuses) {
      const containerName = status?.name || 'container';
      const restartCount = Number(status?.restartCount || 0);
      const info = describeContainerState(status, podName);
      if (!fastFail && environment === 'development' && restartCount > 0) {
        fastFail = buildFastFail({
          reason: 'ContainerRestartedBeforeHealthy',
          message: `Pod ${podName} ${containerName} restarted ${restartCount} time(s) before health check passed.`,
          detail: info?.detail || info?.message || '',
          exitCode: info?.exitCode ?? null,
          podReason,
          podMessage
        });
      }
      if (fastFail || !info) continue;
      const reason = info.reason || '';
      const fatalWaiting = new Set([
        'ImagePullBackOff',
        'ErrImagePull',
        'CreateContainerConfigError',
        'InvalidImageName',
        'ErrImageNeverPull',
        'RunContainerError'
      ]);
      const fatalTerminated = new Set(['Error', 'OOMKilled', 'ContainerCannotRun', 'StartError']);
      if (reason === 'CrashLoopBackOff' && restartCount >= HEALTHCHECK_FAST_FAIL_RESTARTS) {
        fastFail = buildFastFail({
          reason,
          message: info.message,
          detail: info.detail,
          exitCode: info?.exitCode ?? null,
          podReason,
          podMessage
        });
        continue;
      }
      if (fatalWaiting.has(reason)) {
        fastFail = buildFastFail({
          reason,
          message: info.message,
          detail: info.detail,
          exitCode: info?.exitCode ?? null,
          podReason,
          podMessage
        });
        continue;
      }
      if (fatalTerminated.has(reason) || (info.exitCode != null && info.exitCode !== 0)) {
        fastFail = buildFastFail({
          reason,
          message: info.message,
          detail: info.detail,
          exitCode: info?.exitCode ?? null,
          podReason,
          podMessage
        });
      }
    }

    if (!fastFail && phase === 'Failed') {
      fastFail = buildFastFail({
        reason: podReason || 'PodFailed',
        message: `Pod ${podName} failed.`,
        detail: podMessage,
        podReason,
        podMessage
      });
    }

    if (!crashloop) {
      for (const status of containerStatuses) {
        const reason = status.state?.waiting?.reason || '';
        const restartCount = Number(status.restartCount || 0);
        if (reason === 'CrashLoopBackOff' && restartCount >= CRASHLOOP_RESTART_THRESHOLD) {
          crashloop = {
            podName,
            restartCount,
            reason
          };
          break;
        }
      }
    }
  }
  return { ready, fastFail, crashloop, newestPodName, newestPodReady };
}

async function inspectPodsForHealth(projectId, environment) {
  if (isLocalPlatform()) {
    return {
      ready: true,
      fastFail: null,
      crashloop: null,
      newestPodName: '',
      newestPodReady: true,
      pollError: false
    };
  }
  try {
    const pods = await fetchPodsForApp(projectId, environment);
    const analyzed = analyzePodsForHealth(projectId, environment, pods);
    return { ...analyzed, pollError: false };
  } catch (err) {
    return {
      ready: false,
      fastFail: null,
      crashloop: null,
      newestPodName: '',
      newestPodReady: false,
      pollError: true
    };
  }
}

async function detectCrashLoop(projectId, environment) {
  const health = await inspectPodsForHealth(projectId, environment);
  return health.crashloop || null;
}

function describeContainerState(status, podName) {
  const name = status?.name || 'container';
  const waiting = status?.state?.waiting;
  const terminated = status?.state?.terminated;
  const lastTerminated = status?.lastState?.terminated;
  const restartCount = Number(status?.restartCount || 0);
  if (waiting?.reason) {
    const reason = waiting.reason;
    const message = waiting.message || '';
    return {
      reason,
      message: `Pod ${podName} ${name} is waiting (${reason}).`,
      detail: message,
      restartCount
    };
  }
  if (terminated) {
    const reason = terminated.reason || 'Terminated';
    const exitCode = Number(terminated.exitCode ?? -1);
    const message = terminated.message || '';
    return {
      reason,
      message: `Pod ${podName} ${name} terminated (${reason}) with exit code ${exitCode}.`,
      detail: message,
      exitCode,
      restartCount
    };
  }
  if (lastTerminated) {
    const reason = lastTerminated.reason || 'Terminated';
    const exitCode = Number(lastTerminated.exitCode ?? -1);
    const message = lastTerminated.message || '';
    return {
      reason,
      message: `Pod ${podName} ${name} last terminated (${reason}) with exit code ${exitCode}.`,
      detail: message,
      exitCode,
      restartCount
    };
  }
  return null;
}

async function detectFastFail(projectId, environment) {
  const health = await inspectPodsForHealth(projectId, environment);
  return health.fastFail || null;
}

async function checkUrlHealthy(url, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

async function waitForUrlHealthy(url, timeoutMs = HEALTHCHECK_DEFAULTS.timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkUrlHealthy(url, 5000)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, HEALTHCHECK_DEFAULTS.intervalMs)));
  }
  return false;
}

async function checkHealthOnce(projectId, environment, host, appPort) {
  const url = healthcheckUrl(environment, host);
  if (await checkUrlHealthy(url, 5000)) return true;
  if (isLocalPlatform()) {
    const container = `vibes-app-${projectId}-${environment}`;
    const path = healthcheckPathForEnv(environment);
    const cmd = `podman exec ${container} sh -lc \"code=\\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${appPort}${path}); [ \\\"\\$code\\\" -ge 200 ] && [ \\\"\\$code\\\" -lt 400 ]\"`;
    try {
      await exec('sh', ['-lc', cmd]);
      return true;
    } catch { }
  }
  return false;
}

async function waitForHealth(projectId, environment, host, appPort, buildId = null, options = {}) {
  const timeoutMs = Number(options.timeoutMs || HEALTHCHECK_DEFAULTS.timeoutMs);
  const url = healthcheckUrl(environment, host);
  const internalHost = String(options.internalHost || '').trim();
  const internalUrl = internalHost ? healthcheckUrl(environment, internalHost) : '';
  const start = Date.now();
  const deadline = start + timeoutMs;
  const externalTarget = !isLocalPlatform() && !host.endsWith('.svc.cluster.local');
  const configuredAttemptLimit = Number(options.externalAttemptLimit || EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS);
  const externalAttemptLimit = externalTarget
    ? Math.max(1, Number.isFinite(configuredAttemptLimit) ? Math.floor(configuredAttemptLimit) : EXTERNAL_HEALTHCHECK_MAX_ATTEMPTS)
    : 0;
  let externalAttempts = 0;
  let useInternalFallback = false;
  let readyAt = null;

  const stopOnPodFailure = async () => {
    if (isLocalPlatform()) return;
    if (usesDevPodRuntime(environment)) return;
    try {
      await scaleDeploymentToZero(projectId, environment);
    } catch { }
  };

  while (Date.now() < deadline) {
    await ensureBuildNotCancelled(buildId);
    const elapsed = Date.now() - start;

    if (!isLocalPlatform()) {
      const podState = await inspectPodsForHealth(projectId, environment);
      if (podState.fastFail) {
        await stopOnPodFailure();
        return { ok: false, fastFail: podState.fastFail };
      }
      if (podState.crashloop) {
        await stopOnPodFailure();
        return { ok: false, crashloop: podState.crashloop };
      }
      if (externalTarget) {
        if (podState.newestPodReady) {
          if (!readyAt) {
            readyAt = Date.now();
            const podLabel = podState.newestPodName ? ` (${podState.newestPodName})` : '';
            console.log(
              `Newest pod is ready${podLabel} for ${projectId}/${environment}; starting external health checks (${url}, max attempts=${externalAttemptLimit}).`
            );
          }
        } else {
          const delay = Math.min(podReadinessDelayForElapsed(elapsed), Math.max(0, deadline - Date.now()));
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          continue;
        }
      }
    }

    if (externalTarget) {
      if (!useInternalFallback) {
        externalAttempts += 1;
        console.log(`Checking external health for ${url} (${externalAttempts}/${externalAttemptLimit})...`);
        if (await checkUrlHealthy(url, 5000)) return { ok: true };
        if (externalAttempts >= externalAttemptLimit && internalUrl) {
          useInternalFallback = true;
          console.log(
            `External health did not pass after ${externalAttempts} attempt(s); falling back to internal health checks (${internalUrl}).`
          );
        }
      }
    } else {
      console.log(`Checking health for ${url}...`);
      if (await checkUrlHealthy(url, 5000)) return { ok: true };
    }

    if (useInternalFallback && internalUrl) {
      console.log(`Checking internal health for ${internalUrl}...`);
      if (await checkUrlHealthy(internalUrl, 5000)) return { ok: true };
    }

    if (isLocalPlatform()) {
      const container = `vibes-app-${projectId}-${environment}`;
      const path = healthcheckPathForEnv(environment);
      const cmd = `podman exec ${container} sh -lc \"code=\\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${appPort}${path}); [ \\\"\\$code\\\" -ge 200 ] && [ \\\"\\$code\\\" -lt 400 ]\"`;
      try {
        await exec('sh', ['-lc', cmd]);
        return { ok: true };
      } catch { }
    }
    let delay = healthcheckDelayForElapsed(elapsed);
    if (externalTarget && readyAt && !useInternalFallback) {
      delay = externalHealthcheckDelayForReadyElapsed(Date.now() - readyAt);
    } else if (useInternalFallback) {
      delay = podReadinessDelayForElapsed(elapsed);
    }
    delay = Math.min(delay, Math.max(0, deadline - Date.now()));
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { ok: false };
}

function deployCommandForEnv(environment) {
  if (isLocalPlatform()) return DEV_DEPLOY_COMMAND;
  if (environment === 'development' && DEV_DEPLOY_COMMAND) return DEV_DEPLOY_COMMAND;
  if (environment === 'testing' && TEST_DEPLOY_COMMAND) return TEST_DEPLOY_COMMAND;
  if (environment === 'production' && PROD_DEPLOY_COMMAND) return PROD_DEPLOY_COMMAND;
  return PROD_DEPLOY_COMMAND || DEV_DEPLOY_COMMAND || null;
}

function deleteCommandForEnv(environment) {
  if (environment === 'development') return DEV_DELETE_COMMAND;
  if (environment === 'testing') return TEST_DELETE_COMMAND;
  if (environment === 'production') return PROD_DELETE_COMMAND;
  return null;
}

function scaleToZeroThresholdMs(environment) {
  if (environment === 'development') return DEV_SCALE_TO_ZERO_AFTER_MS;
  if (environment === 'testing') return TEST_SCALE_TO_ZERO_AFTER_MS;
  return 0;
}

async function hasActiveTasks(projectId, environment) {
  const result = await pool.query(
    `select 1
     from tasks
     where project_id = $1
       and environment = $2
       and status in ('queued', 'running')
     limit 1`,
    [projectId, environment]
  );
  return result.rowCount > 0;
}

async function scaleDeploymentToZero(projectId, environment) {
  if (isLocalPlatform()) {
    if (environment !== 'development') return 'skipped';
    const container = `vibes-app-${projectId}-${environment}`;
    try {
      await exec('sh', ['-lc', `podman stop ${container} >/dev/null 2>&1 || true`]);
      return 'scaled';
    } catch (err) {
      console.warn(`Scale to zero failed for ${container}`, err?.message || err);
      return 'failed';
    }
  }
  const namespace = `vibes-${environment}`;
  const appName = `vibes-app-${projectId}`;
  const usePodRuntime = usesDevPodRuntime(environment);
  let deploymentMissing = false;
  let scaled = false;

  if (!usePodRuntime) {
    const cmd = `kubectl -n ${namespace} scale deployment ${appName} --replicas=0`;
    try {
      await exec('sh', ['-lc', cmd]);
      scaled = true;
    } catch (err) {
      const msg = `${err?.stderr || ''}\n${err?.message || ''}`.toLowerCase();
      if (msg.includes('notfound') || msg.includes('not found')) {
        deploymentMissing = true;
        console.warn(`Scale to zero: deployment ${appName} not found in ${namespace}`);
      } else {
        console.warn(`Scale to zero failed for ${appName}`, err?.message || err);
      }
    }
  }

  if (usePodRuntime || deploymentMissing) {
    try {
      await exec('sh', [
        '-lc',
        `kubectl -n ${namespace} delete pod -l app=${appName} --ignore-not-found --wait=false`
      ]);
      scaled = true;
    } catch (err) {
      console.warn(`Scale to zero pod delete failed for ${appName}`, err?.message || err);
    }
  }

  if (scaled) return 'scaled';
  if (deploymentMissing) return 'missing';
  return 'failed';
}

async function clearPendingDeployJobs(projectId, environment) {
  try {
    const jobs = await taskQueue.getJobs(['waiting', 'delayed']);
    for (const job of jobs) {
      if (job.name !== 'deploy-commit') continue;
      if (job.data?.projectId !== projectId) continue;
      if (job.data?.environment !== environment) continue;
      try {
        await job.remove();
      } catch {}
    }
  } catch (err) {
    console.warn('Failed to clear pending deploy jobs', err?.message || err);
  }
}

async function cancelLatestBuild(projectId, environment, reason) {
  const buildRes = await pool.query(
    `select id
       from builds
      where project_id = $1
        and environment = $2
        and status = 'building'
      order by created_at desc
      limit 1`,
    [projectId, environment]
  );
  const buildId = buildRes.rows[0]?.id || null;
  if (!buildId) return null;
  await pool.query(
    `update builds
        set cancel_requested = true,
            build_log = coalesce(build_log, '') || $1,
            updated_at = now()
      where id = $2`,
    [reason, buildId]
  );
  return buildId;
}

async function removeQueuedDevelopmentJobs(projectId, jobNames, environment = 'development') {
  const allowedNames = new Set(jobNames || []);
  const jobs = await taskQueue.getJobs(['waiting', 'delayed']);
  let removed = 0;
  for (const job of jobs) {
    if (!allowedNames.has(job.name)) continue;
    if (job.data?.projectId !== projectId) continue;
    if (job.name === 'deploy-commit' && job.data?.environment !== environment) continue;
    try {
      await job.remove();
      removed += 1;
    } catch {}
  }
  return removed;
}

async function cancelSupersededDevelopmentWork(projectId, reason) {
  const [buildId, removed] = await Promise.all([
    cancelLatestBuild(projectId, 'development', reason),
    removeQueuedDevelopmentJobs(
      projectId,
      new Set(['deploy-commit', 'verify-development-preview', 'verify-development-workspace'])
    ).catch((err) => {
      console.warn('Failed to remove superseded development jobs', err?.message || err);
      return 0;
    })
  ]);
  return { buildId, removed };
}

async function stopEnvironment(projectId, environment) {
  if (String(environment || '').toLowerCase() === 'development') {
    await cancelSupersededDevelopmentWork(
      projectId,
      '\n\n[system] Cancel requested because the development environment was stopped.\n'
    );
  } else {
    await clearPendingDeployJobs(projectId, environment);
  }
  if (!isLocalPlatform() && String(environment || '').toLowerCase() === 'development') {
    await sleepWorkspace(projectId, { routeToVerified: false });
  }
  await scaleDeploymentToZero(projectId, environment);
  clearRuntimeLogStreamState(projectId, environment);
  let refCommit = null;
  try {
    const envRes = await pool.query(
      'select deployed_commit from environments where project_id = $1 and name = $2',
      [projectId, environment]
    );
    refCommit = envRes.rows[0]?.deployed_commit || null;
  } catch {}
  await updateBuildStatus(projectId, environment, 'offline', refCommit);
}

function sortPodsNewestFirst(pods) {
  const next = Array.isArray(pods) ? [...pods] : [];
  next.sort((a, b) => {
    const aTime = new Date(a?.status?.startTime || a?.metadata?.creationTimestamp || 0).getTime();
    const bTime = new Date(b?.status?.startTime || b?.metadata?.creationTimestamp || 0).getTime();
    return bTime - aTime;
  });
  return next;
}

async function fetchCurrentPodLogSnapshot(projectId, environment, lines = RUNTIME_LOG_CAPTURE_LINES) {
  const tail = Math.max(1, Math.min(Number(lines) || RUNTIME_LOG_CAPTURE_LINES, 4000));
  if (isLocalPlatform()) {
    if (environment !== 'development') return { snapshot: '', podName: '', namespace: '', statuses: [] };
    const container = `vibes-app-${projectId}-${environment}`;
    try {
      const { stdout, stderr } = await exec('sh', ['-lc', `podman logs --timestamps --tail=${tail} ${container}`]);
      return {
        snapshot: `${stdout || ''}${stderr || ''}`.trim(),
        podName: container,
        namespace: 'local',
        statuses: []
      };
    } catch {
      return { snapshot: '', podName: container, namespace: 'local', statuses: [] };
    }
  }
  const namespace = `vibes-${environment}`;
  const pods = sortPodsNewestFirst(await fetchPodsForApp(projectId, environment));
  if (!pods.length) return { snapshot: '', podName: '', namespace, statuses: [] };
  const pod = pods[0];
  const podName = pod?.metadata?.name || '';
  const statuses = [
    ...(pod?.status?.initContainerStatuses || []),
    ...(pod?.status?.containerStatuses || [])
  ];
  if (!podName) return { snapshot: '', podName: '', namespace, statuses };
  try {
    const { stdout, stderr } = await exec('sh', [
      '-lc',
      `kubectl -n ${namespace} logs ${podName} --tail=${tail} --timestamps`
    ]);
    return {
      snapshot: `${stdout || ''}${stderr || ''}`.trim(),
      podName,
      namespace,
      statuses
    };
  } catch (err) {
    console.warn(`kubectl logs failed for ${podName}`, err?.message || err);
    return { snapshot: '', podName, namespace, statuses };
  }
}

function formatRestartReason(status) {
  const waiting = status?.state?.waiting;
  const terminated = status?.state?.terminated;
  const lastTerminated = status?.lastState?.terminated;
  const reason = waiting?.reason || terminated?.reason || lastTerminated?.reason || '';
  const exitCode = terminated?.exitCode ?? lastTerminated?.exitCode;
  const signal = terminated?.signal ?? lastTerminated?.signal;
  const detail = [];
  if (reason) detail.push(reason);
  if (Number.isFinite(Number(exitCode)) && Number(exitCode) >= 0) detail.push(`exit ${Number(exitCode)}`);
  if (Number.isFinite(Number(signal)) && Number(signal) > 0) detail.push(`signal ${Number(signal)}`);
  return detail.join(', ');
}

async function fetchPreviousContainerLogs(namespace, podName, containerName, lines = RUNTIME_LOG_PREVIOUS_TAIL_LINES) {
  const tail = Math.max(10, Math.min(Number(lines) || RUNTIME_LOG_PREVIOUS_TAIL_LINES, 2000));
  if (!namespace || !podName || !containerName) return '';
  try {
    const { stdout, stderr } = await exec('sh', [
      '-lc',
      `kubectl -n ${namespace} logs ${podName} -c ${containerName} --previous --tail=${tail} --timestamps`
    ]);
    return `${stdout || ''}${stderr || ''}`.trim();
  } catch {
    return '';
  }
}

async function fetchPodTailByName(namespace, podName, lines = RUNTIME_LOG_PREVIOUS_TAIL_LINES) {
  const tail = Math.max(10, Math.min(Number(lines) || RUNTIME_LOG_PREVIOUS_TAIL_LINES, 2000));
  if (!namespace || !podName) return '';
  try {
    const { stdout, stderr } = await exec('sh', [
      '-lc',
      `kubectl -n ${namespace} logs ${podName} --tail=${tail} --timestamps`
    ]);
    return `${stdout || ''}${stderr || ''}`.trim();
  } catch {
    return '';
  }
}

async function captureLatestRuntimeLog(projectId, environment, attemptId = null) {
  const key = runtimeLogKey(projectId, environment);
  const normalizedAttempt = attemptId || null;
  const existing = runtimeLogStreamState.get(key);
  const state =
    existing && existing.attemptId === normalizedAttempt
      ? existing
      : { attemptId: normalizedAttempt, lastSnapshot: '', restartCounts: new Map(), lastPodName: '' };

  const snapshotData = await fetchCurrentPodLogSnapshot(projectId, environment, RUNTIME_LOG_CAPTURE_LINES);
  const nextSnapshot = String(snapshotData?.snapshot || '').replace(/\r/g, '');
  const appendChunks = [];
  const previousPodName = state.lastPodName || '';
  const currentPodName = snapshotData.podName || '';

  if (!isLocalPlatform() && previousPodName && currentPodName && previousPodName !== currentPodName) {
    appendChunks.push(
      `[system] Active pod switched from ${previousPodName} to ${currentPodName}; attempting to capture tail from previous pod.`
    );
    const previousPodTail = await fetchPodTailByName(
      snapshotData.namespace,
      previousPodName,
      RUNTIME_LOG_PREVIOUS_TAIL_LINES
    );
    if (previousPodTail) {
      appendChunks.push(`[pod ${previousPodName} tail]\n${previousPodTail}`);
    }
  }
  if (currentPodName) state.lastPodName = currentPodName;

  for (const status of snapshotData.statuses || []) {
    const containerName = status?.name || 'container';
    const restartCount = Number(status?.restartCount || 0);
    if (!Number.isFinite(restartCount) || restartCount <= 0) continue;
    const restartKey = `${snapshotData.podName}/${containerName}`;
    const previousCount = Number(state.restartCounts.get(restartKey) || 0);
    if (restartCount > previousCount) {
      const reason = formatRestartReason(status);
      appendChunks.push(
        `[system] Container restart detected for ${restartKey}: restart count ${restartCount}${reason ? ` (${reason})` : ''}.`
      );
      if (!isLocalPlatform()) {
        const previousLogs = await fetchPreviousContainerLogs(
          snapshotData.namespace,
          snapshotData.podName,
          containerName,
          RUNTIME_LOG_PREVIOUS_TAIL_LINES
        );
        if (previousLogs) {
          appendChunks.push(`[previous ${restartKey}]\n${previousLogs}`);
        }
      }
    }
    state.restartCounts.set(restartKey, restartCount);
  }

  const previousSnapshot = state.lastSnapshot || '';
  if (!previousSnapshot && nextSnapshot) {
    appendChunks.push(nextSnapshot);
  } else if (previousSnapshot) {
    const delta = computeLogDelta(previousSnapshot, nextSnapshot);
    if (delta.reset) {
      appendChunks.push('[system] Log stream reset detected; continuing with latest container output.');
      if (delta.lines.length) appendChunks.push(delta.lines.join('\n'));
    } else if (delta.lines.length) {
      appendChunks.push(delta.lines.join('\n'));
    }
  }
  state.lastSnapshot = nextSnapshot;
  runtimeLogStreamState.set(key, state);

  if (!appendChunks.length) return;
  const payload = `${appendChunks
    .map((chunk) => String(chunk || '').trimEnd())
    .filter(Boolean)
    .join('\n\n')}\n`;
  await appendLatestRuntimeLog(projectId, environment, payload, normalizedAttempt);
}

async function fetchPodLogs(projectId, environment, lines = 10) {
  const tail = Math.max(1, Math.min(Number(lines) || 10, 2000));
  if (isLocalPlatform()) {
    if (environment !== 'development') return '';
    const container = `vibes-app-${projectId}-${environment}`;
    try {
      const { stdout, stderr } = await exec('sh', ['-lc', `podman logs --timestamps --tail=${tail} ${container}`]);
      return `${stdout || ''}${stderr || ''}`.trim();
    } catch (err) {
      console.warn(`Podman logs failed for ${container}`, err?.message || err);
      return '';
    }
  }
  const namespace = `vibes-${environment}`;
  const appName = `vibes-app-${projectId}`;
  try {
    const pods = sortPodsNewestFirst(await fetchPodsForApp(projectId, environment));
    if (!pods.length) return '';
    const podName = pods[0]?.metadata?.name;
    if (!podName) return '';
    const { stdout: logOut, stderr: logErr } = await exec('sh', [
      '-lc',
      `kubectl -n ${namespace} logs ${podName} --tail=${tail} --timestamps`
    ]);
    let combined = `${logOut || ''}${logErr || ''}`.trim();
    try {
      const { stdout: prevOut, stderr: prevErr } = await exec('sh', [
        '-lc',
        `kubectl -n ${namespace} logs ${podName} --previous --tail=${tail} --timestamps`
      ]);
      const previous = `${prevOut || ''}${prevErr || ''}`.trim();
      if (previous) {
        combined = [combined, '--- previous ---', previous].filter(Boolean).join('\n');
      }
    } catch {}
    return combined;
  } catch (err) {
    console.warn(`kubectl logs failed for ${appName}`, err?.message || err);
    return '';
  }
}

async function captureRuntimeFailureEvidence(projectId, environment, attemptId = null) {
  const normalizedAttempt = attemptId || null;
  try {
    for (let i = 0; i < 3; i += 1) {
      await captureLatestRuntimeLog(projectId, environment, normalizedAttempt);
      if (i < 2) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (INCLUDE_RUNTIME_FAILURE_BOUNDARY_LOGS) {
      const podLogs = await fetchPodLogs(projectId, environment, Math.min(HEALTHCHECK_LOG_LINES, 400));
      if (podLogs) {
        await appendLatestRuntimeLog(
          projectId,
          environment,
          `[system] Runtime logs captured at failure boundary:\n${podLogs}\n`,
          normalizedAttempt
        );
      }
    }
  } catch (err) {
    console.warn('Failed to capture runtime failure evidence', err?.message || err);
  }
}

async function detectRuntimeRestarts(projectId, environment) {
  if (isLocalPlatform()) return null;
  const namespace = `vibes-${environment}`;
  const appName = `vibes-app-${projectId}`;
  try {
    const { stdout } = await exec('sh', ['-lc', `kubectl -n ${namespace} get pods -l app=${appName} -o json`]);
    const data = JSON.parse(stdout || '{}');
    const pods = Array.isArray(data.items) ? data.items : [];
    if (!pods.length) return null;
    const entries = [];
    for (const pod of pods) {
      const podName = pod?.metadata?.name || 'unknown';
      const statuses = [
        ...(pod?.status?.initContainerStatuses || []),
        ...(pod?.status?.containerStatuses || [])
      ];
      for (const status of statuses) {
        const restartCount = Number(status?.restartCount || 0);
        if (restartCount <= 0) continue;
        const reason =
          status?.state?.waiting?.reason ||
          status?.state?.terminated?.reason ||
          status?.lastState?.terminated?.reason ||
          '';
        const message =
          status?.state?.waiting?.message ||
          status?.state?.terminated?.message ||
          status?.lastState?.terminated?.message ||
          '';
        entries.push({
          podName,
          containerName: status?.name || 'container',
          restartCount,
          reason,
          message
        });
      }
    }
    if (!entries.length) return null;
    const totalRestarts = entries.reduce((sum, entry) => sum + Number(entry.restartCount || 0), 0);
    const summary = entries
      .slice(0, 12)
      .map((entry) => {
        const reason = entry.reason ? ` (${entry.reason})` : '';
        const message = entry.message ? ` ${String(entry.message).slice(0, 180)}` : '';
        return `- ${entry.podName}/${entry.containerName}: restarts ${entry.restartCount}${reason}${message}`;
      })
      .join('\n');
    return { totalRestarts, summary, entries };
  } catch (err) {
    console.warn(`Restart detection failed for ${appName}`, err?.message || err);
    return null;
  }
}

async function fetchRecentPodEvents(namespace, podName, limit = 8) {
  if (!podName) return [];
  try {
    const { stdout } = await exec('sh', [
      '-lc',
      `kubectl -n ${namespace} get events --field-selector involvedObject.kind=Pod,involvedObject.name=${podName} -o json`
    ]);
    const data = JSON.parse(stdout || '{}');
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .map((item) => ({
        reason: item?.reason || '',
        message: item?.message || '',
        type: item?.type || '',
        time:
          item?.lastTimestamp ||
          item?.eventTime ||
          item?.firstTimestamp ||
          item?.metadata?.creationTimestamp ||
          ''
      }))
      .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
      .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
  } catch {
    return [];
  }
}

function classifyFailureFromEvents(events = []) {
  for (const event of events) {
    const reason = String(event?.reason || '');
    const detail = String(event?.message || '');
    const classification = classifyRuntimeFailure({ reason, detail });
    if (classification.category !== 'unknown') return classification;
  }
  return null;
}

async function detectLikelyRuntimeFailure(projectId, environment) {
  if (isLocalPlatform()) return null;
  try {
    const namespace = `vibes-${environment}`;
    const pods = sortPodsNewestFirst(await fetchPodsForApp(projectId, environment));
    if (!pods.length) {
      return {
        podName: '',
        reason: 'PodMissing',
        exitCode: null,
        classification: {
          category: 'platform_disruption',
          label: 'Cluster disruption',
          reason: 'PodMissing'
        },
        events: []
      };
    }
    const pod = pods[0];
    const podName = pod?.metadata?.name || '';
    const podReason = pod?.status?.reason || '';
    const podMessage = pod?.status?.message || '';
    const statuses = [
      ...(pod?.status?.initContainerStatuses || []),
      ...(pod?.status?.containerStatuses || [])
    ];
    const firstState = statuses.map((status) => describeContainerState(status, podName)).find(Boolean) || null;
    let classification = classifyRuntimeFailure({
      reason: firstState?.reason || podReason,
      detail: firstState?.detail || podMessage,
      exitCode: firstState?.exitCode ?? null,
      podReason,
      podMessage
    });
    const events = await fetchRecentPodEvents(namespace, podName);
    const eventClassification = classifyFailureFromEvents(events);
    if (
      eventClassification &&
      (classification.category === 'unknown' || eventClassification.category === 'platform_disruption')
    ) {
      classification = eventClassification;
    }
    return {
      podName,
      reason: firstState?.reason || podReason || '',
      exitCode: firstState?.exitCode ?? null,
      classification,
      events
    };
  } catch {
    return null;
  }
}

async function buildHealthcheckError(projectId, environment, host) {
  const podLogs = await fetchPodLogs(projectId, environment, HEALTHCHECK_LOG_LINES);
  const failure = await detectLikelyRuntimeFailure(projectId, environment);
  const classificationLine = formatFailureClassification(failure?.classification || null);
  const eventsText = Array.isArray(failure?.events) && failure.events.length
    ? `Recent pod events:\n${failure.events
        .map((event) => `- ${event.type || 'Normal'} ${event.reason || ''}: ${String(event.message || '').slice(0, 240)}`)
        .join('\n')}`
    : '';
  const podSummary = failure?.podName
    ? `Pod status: ${failure.podName}${failure.reason ? ` reason=${failure.reason}` : ''}${
        Number.isFinite(failure.exitCode) ? ` exit=${failure.exitCode}` : ''
      }`
    : '';
  const detail = [
    classificationLine,
    podSummary,
    eventsText,
    podLogs
      ? `Pod logs (last ${HEALTHCHECK_LOG_LINES} lines, latest + previous if available):\n${podLogs}`
      : 'Pod logs unavailable.'
  ]
    .filter(Boolean)
    .join('\n\n');
  const err = new Error(`Health check failed for ${host}`);
  err.code = 'healthcheck_failed';
  err.detail = detail;
  err.podLogs = podLogs;
  err.classification = failure?.classification || null;
  err.host = host;
  err.environment = environment;
  err.projectId = projectId;
  return err;
}

async function resumeDeployment(projectId, environment, envPath) {
  if (isLocalPlatform()) return false;
  if (usesDevPodRuntime(environment)) return false;
  const namespace = `vibes-${environment}`;
  const appName = `vibes-app-${projectId}`;
  const rdsCaPath = process.env.RDS_CA_PATH || '/etc/ssl/certs/rds-ca.pem';
  try {
    await exec('sh', ['-lc', `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`]);
    try {
      await exec('sh', ['-lc', `kubectl -n ${namespace} get deployment ${appName} >/dev/null 2>&1`]);
    } catch {
      return false;
    }
    await exec('sh', ['-lc', `kubectl -n ${namespace} delete secret ${appName}-env --ignore-not-found`]);
    await exec('sh', ['-lc', `kubectl -n ${namespace} create secret generic ${appName}-env --from-env-file=${envPath}`]);
    if (await fileExists(rdsCaPath)) {
      await exec('sh', [
        '-lc',
        `kubectl -n ${namespace} create secret generic rds-ca-bundle --from-file=rds-ca.pem=${rdsCaPath} --dry-run=client -o yaml | kubectl apply -f -`
      ]);
    }
    await exec('sh', ['-lc', `kubectl -n ${namespace} scale deployment ${appName} --replicas=1`]);
    return true;
  } catch (err) {
    console.warn(`Resume deployment failed for ${appName} in ${namespace}`, err?.message || err);
    return false;
  }
}

async function shouldFastResume(projectId, environment, commitHash) {
  if (environment !== 'development') return false;
  if (usesDevPodRuntime(environment)) return false;
  if (!commitHash) return false;
  if (isLocalPlatform()) return false;
  const envRes = await pool.query(
    'select deployed_commit, build_status from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  if (envRes.rowCount === 0) return false;
  const row = envRes.rows[0];
  if (row.build_status !== 'offline') return false;
  if (!row.deployed_commit || row.deployed_commit !== commitHash) return false;
  return true;
}

async function fastResumeEnvironment(projectId, environment, commitHash, buildId = null) {
  console.log(`Fast resume project ${projectId} environment ${environment}...`);
  const settingsRes = await pool.query(
    `select key, value from settings
     where key in (
       'healthcheck_path',
       'healthcheck_path_dev',
       'healthcheck_path_test',
       'healthcheck_path_prod',
       'healthcheck_protocol',
       'healthcheck_protocol_dev',
       'healthcheck_protocol_test',
       'healthcheck_protocol_prod',
       'healthcheck_timeout_ms',
       'healthcheck_interval_ms'
     )`
  );
  const settings = {};
  for (const row of settingsRes.rows) settings[row.key] = row.value;
  if (settings.healthcheck_path) HEALTHCHECK_DEFAULTS.path = settings.healthcheck_path;
  if (settings.healthcheck_path_dev) HEALTHCHECK_DEFAULTS.pathDev = settings.healthcheck_path_dev;
  if (settings.healthcheck_path_test) HEALTHCHECK_DEFAULTS.pathTest = settings.healthcheck_path_test;
  if (settings.healthcheck_path_prod) HEALTHCHECK_DEFAULTS.pathProd = settings.healthcheck_path_prod;
  if (settings.healthcheck_protocol) HEALTHCHECK_DEFAULTS.protocol = settings.healthcheck_protocol;
  if (settings.healthcheck_protocol_dev) HEALTHCHECK_DEFAULTS.protocolDev = settings.healthcheck_protocol_dev;
  if (settings.healthcheck_protocol_test) HEALTHCHECK_DEFAULTS.protocolTest = settings.healthcheck_protocol_test;
  if (settings.healthcheck_protocol_prod) HEALTHCHECK_DEFAULTS.protocolProd = settings.healthcheck_protocol_prod;
  if (settings.healthcheck_timeout_ms) HEALTHCHECK_DEFAULTS.timeoutMs = Number(settings.healthcheck_timeout_ms);
  if (settings.healthcheck_interval_ms) HEALTHCHECK_DEFAULTS.intervalMs = Number(settings.healthcheck_interval_ms);

  const envRes = await pool.query(
    'select env_vars, db_url, db_name from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  const projectRes = await pool.query(
    'select name, short_id, project_slug from projects where id = $1',
    [projectId]
  );
  const project = projectRes.rows[0];
  if (!project?.short_id) throw new Error('Project not found');
  const envVars = envRes.rows[0]?.env_vars || {};
  let dbUrl = envRes.rows[0]?.db_url || null;
  const dbName = envRes.rows[0]?.db_name || dbNameFor(project.short_id, environment);
  if (!dbUrl || !dbUrlMatchesConfig(dbUrl)) {
    await ensureDatabase(dbName);
    dbUrl = dbUrlFor(dbName);
    await pool.query(
      `insert into environments (project_id, name, db_name, db_url)
       values ($1, $2, $3, $4)
       on conflict (project_id, name)
       do update set db_name = excluded.db_name, db_url = excluded.db_url`,
      [projectId, environment, dbName, dbUrl]
    );
  }

  const { envPath, tempDir: envTemp } = await writeEnvFile(envVars, dbUrl);
  try {
    const resumed = await resumeDeployment(projectId, environment, envPath);
    if (!resumed) return null;
  } finally {
    await fs.rm(envTemp, { recursive: true, force: true });
  }

  const host = hostFor(project, environment);
  const appName = `vibes-app-${projectId}`;
  const namespace = `vibes-${environment}`;
  const internalHost = `${appName}.${namespace}.svc.cluster.local`;
  const healthHost = deploymentHealthHost(environment, host, internalHost);
  const healthTimeoutMs = healthTimeoutForHost(healthHost);
  const appPort = Number(envVars.PORT || process.env.PORT || 3000);
  await ensureBuildNotCancelled(buildId);
  const health = await waitForHealth(projectId, environment, healthHost, appPort, buildId, {
    timeoutMs: healthTimeoutMs,
    internalHost
  });
  if (!health.ok) {
    if (health.fastFail) {
      const detail = [
        formatFailureClassification(health.fastFail.classification || null),
        health.fastFail.message,
        health.fastFail.detail
      ]
        .filter(Boolean)
        .join('\n');
      const err = new Error(`Deploy failed early: ${health.fastFail.reason || 'pod_error'}`);
      err.code = 'deploy_failed_fast';
      err.detail = detail;
      err.classification = health.fastFail.classification || null;
      err.host = host;
      throw err;
    }
    const err = await buildHealthcheckError(projectId, environment, host);
    if (health.crashloop) {
      const detail = `CrashLoopBackOff detected (${health.crashloop.restartCount} restarts) on pod ${health.crashloop.podName || 'unknown'}.`;
      err.detail = `${detail}\n\n${err.detail || ''}`.trim();
    }
    throw err;
  }
  return `Fast resume: scaled ${appName} to 1 (commit ${commitHash})`;
}

function hostProjectName(name) {
  const cleaned = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'app';
}

function normalizeDomain(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function appDomainForHosts() {
  const explicit = normalizeDomain(process.env.APP_DOMAIN);
  if (explicit) return explicit;
  const fallback = normalizeDomain(process.env.DOMAIN);
  if (!fallback) return 'localhost:8000';
  // Common prod setup keeps API on api.<domain>; app hosts should use the apex wildcard.
  if (fallback.startsWith('api.') && fallback.split('.').length >= 3) {
    return fallback.slice(4);
  }
  return fallback;
}

function hostFor(project, environment) {
  const domain = appDomainForHosts();
  const slug = project?.project_slug || hostProjectName(project?.name);
  const suffix = project?.short_id ? `-${project.short_id}` : '';
  // Use a single-label subdomain so it matches *.vibesplatform.ai wildcard certs.
  return environment === 'production'
    ? `${slug}${suffix}.${domain}`
    : `${slug}-${environment}${suffix}.${domain}`;
}

function albLogsEnabled() {
  return Boolean(ALB_LOG_BUCKET && ALB_LOG_PREFIX);
}

function normalizedAlbPrefix() {
  const raw = String(ALB_LOG_PREFIX || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return raw ? `${raw}/` : '';
}

function buildAlbPrefixes(lookbackHours) {
  const basePrefix = normalizedAlbPrefix();
  const prefixes = new Set();
  const now = new Date();
  const start = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor <= now) {
    const yyyy = cursor.getUTCFullYear();
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getUTCDate()).padStart(2, '0');
    prefixes.add(`${basePrefix}${yyyy}/${mm}/${dd}/`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Array.from(prefixes);
}

async function listAlbLogObjects(prefix) {
  const cmd =
    `aws s3api list-objects-v2 --bucket ${ALB_LOG_BUCKET}` +
    ` --prefix '${prefix}' --region ${ALB_LOG_REGION}` +
    ` --query 'Contents[].{Key:Key,LastModified:LastModified}' --output json`;
  try {
    const { stdout } = await exec('sh', ['-lc', cmd]);
    const items = JSON.parse(stdout || '[]');
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && item.Key)
      .map((item) => ({
        key: String(item.Key),
        lastModified: item.LastModified ? new Date(item.LastModified).getTime() : 0
      }));
  } catch (err) {
    console.warn('Failed to list ALB logs', err?.message || err);
    return [];
  }
}

async function listAlbLogKeys() {
  if (!albLogsEnabled()) return [];
  const prefixes = buildAlbPrefixes(ALB_LOG_LOOKBACK_HOURS);
  const startMs = Date.now() - ALB_LOG_LOOKBACK_HOURS * 60 * 60 * 1000;
  const items = [];
  for (const prefix of prefixes) {
    const entries = await listAlbLogObjects(prefix);
    for (const entry of entries) {
      if (!entry.key) continue;
      if (entry.lastModified && entry.lastModified < startMs) continue;
      items.push(entry);
    }
  }
  items.sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));
  const keys = items.map((item) => item.key);
  if (keys.length <= ALB_LOG_MAX_FILES) return keys;
  return keys.slice(keys.length - ALB_LOG_MAX_FILES);
}

async function filterUnprocessedAlbKeys(keys) {
  if (!keys.length) return [];
  try {
    const existing = new Set();
    const chunkSize = 500;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const result = await pool.query(
        'select s3_key from bandwidth_log_ingest where s3_key = any($1)',
        [chunk]
      );
      for (const row of result.rows) existing.add(row.s3_key);
    }
    return keys.filter((key) => !existing.has(key));
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('bandwidth_log_ingest')) {
      console.warn('bandwidth_log_ingest table missing; skipping ALB ingest');
      return [];
    }
    throw err;
  }
}

function splitAlbLogLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ' ' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length) fields.push(current);
  return fields;
}

function extractHostFromRequest(request, domainField) {
  if (domainField && domainField !== '-') {
    domainField = String(domainField).trim();
  }
  if (!request || request === '-') return domainField || '';
  const parts = String(request).split(' ');
  const urlPart = parts[1];
  if (!urlPart) return domainField || '';
  if (urlPart.startsWith('http://') || urlPart.startsWith('https://')) {
    try {
      const url = new URL(urlPart);
      return url.hostname || url.host || '';
    } catch {
      return domainField || '';
    }
  }
  return domainField || '';
}

function monthKeyFromTimestamp(timestamp) {
  const parsed = Date.parse(timestamp || '');
  if (!Number.isFinite(parsed)) return currentMonthKey();
  return new Date(parsed).toISOString().slice(0, 7);
}

async function loadProjectHostMap() {
  const result = await pool.query('select id, name, short_id, project_slug from projects');
  const map = new Map();
  for (const row of result.rows) {
    for (const env of ['development', 'testing', 'production']) {
      const host = hostFor(row, env).toLowerCase();
      map.set(host, { projectId: row.id, environment: env });
      if (host.includes(':')) {
        map.set(host.split(':')[0], { projectId: row.id, environment: env });
      }
    }
  }
  return map;
}

async function parseAlbLogObject(key, hostMap) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-alb-'));
  const filePath = path.join(tmpDir, path.basename(key));
  try {
    await exec('sh', ['-lc', `aws s3 cp "s3://${ALB_LOG_BUCKET}/${key}" "${filePath}" --region ${ALB_LOG_REGION}`]);
    let stream = fsSync.createReadStream(filePath);
    if (key.endsWith('.gz')) {
      stream = stream.pipe(zlib.createGunzip());
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const usage = new Map();
    for await (const line of rl) {
      if (!line) continue;
      const fields = splitAlbLogLine(line);
      if (fields.length < 13) continue;
      const sentRaw = fields[11];
      const sentBytes = Number(sentRaw);
      const request = fields[12];
      const domainField = fields[18];
      const host = extractHostFromRequest(request, domainField).toLowerCase();
      if (!host) continue;
      const match = hostMap.get(host) || hostMap.get(host.split(':')[0]);
      if (!match) continue;
      const month = monthKeyFromTimestamp(fields[1]);
      const bytes = Number.isFinite(sentBytes) ? Math.max(0, sentBytes) : 0;
      if (!bytes) continue;
      const keyId = `${match.projectId}:${month}`;
      usage.set(keyId, (usage.get(keyId) || 0) + bytes);
    }
    return usage;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function markAlbLogProcessed(key) {
  try {
    await pool.query(
      `insert into bandwidth_log_ingest (s3_key)
       values ($1)
       on conflict (s3_key) do nothing`,
      [key]
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('bandwidth_log_ingest')) return;
    throw err;
  }
}

async function flushBandwidthUsage(usageMap) {
  for (const [key, bytes] of usageMap.entries()) {
    const [projectId, month] = key.split(':');
    if (!projectId || !month) continue;
    await pool.query(
      `insert into bandwidth_usage (project_id, month, bytes_out)
       values ($1, $2, $3)
       on conflict (project_id, month)
       do update set bytes_out = bandwidth_usage.bytes_out + excluded.bytes_out,
                     updated_at = now()`,
      [projectId, month, Math.floor(bytes)]
    );
  }
}

let albIngestRunning = false;

async function ingestAlbLogs() {
  if (albIngestRunning) return;
  if (!albLogsEnabled()) return;
  albIngestRunning = true;
  try {
    const keys = await listAlbLogKeys();
    const unprocessed = await filterUnprocessedAlbKeys(keys);
    if (unprocessed.length === 0) return;
    const hostMap = await loadProjectHostMap();
    const usageTotals = new Map();
    for (const key of unprocessed) {
      try {
        const usage = await parseAlbLogObject(key, hostMap);
        for (const [usageKey, bytes] of usage.entries()) {
          usageTotals.set(usageKey, (usageTotals.get(usageKey) || 0) + bytes);
        }
        await markAlbLogProcessed(key);
      } catch (err) {
        console.warn('Failed to ingest ALB log', key, err?.message || err);
      }
    }
    if (usageTotals.size > 0) {
      await flushBandwidthUsage(usageTotals);
    }
  } finally {
    albIngestRunning = false;
  }
}

let bandwidthReconcileRunning = false;

async function reconcileBandwidthLimits() {
  if (bandwidthReconcileRunning) return;
  bandwidthReconcileRunning = true;
  try {
    await ingestAlbLogs();
    const month = currentMonthKey();
    const usageRes = await pool.query(
      `select b.project_id, b.bytes_out, u.plan as user_plan
       from bandwidth_usage b
       join projects p on p.id = b.project_id
       join users u on u.id = p.owner_id
       where b.month = $1`,
      [month]
    );
    if (usageRes.rowCount === 0) return;
    const overLimitProjects = new Set();
    for (const row of usageRes.rows) {
      const planName = normalizePlanName(row.user_plan || DEFAULT_USER_PLAN);
      const limitGb = Number(resolvePlanLimits(planName)?.bandwidth_gb || 0);
      if (!limitGb) continue;
      const usedBytes = Number(row.bytes_out || 0);
      if (usedBytes >= limitGb * 1024 * 1024 * 1024) {
        overLimitProjects.add(row.project_id);
      }
    }
    if (overLimitProjects.size === 0) return;
    const envRes = await pool.query(
      `select project_id, name, deployed_commit
       from environments
       where build_status = 'live'
         and project_id = any($1)`,
      [Array.from(overLimitProjects)]
    );
    for (const row of envRes.rows) {
      const outcome = await scaleDeploymentToZero(row.project_id, row.name);
      if (outcome === 'failed') continue;
      await updateBuildStatus(row.project_id, row.name, 'offline', row.deployed_commit || null);
    }
  } catch (err) {
    console.error('Bandwidth reconcile failed', err);
  } finally {
    bandwidthReconcileRunning = false;
  }
}

async function writeEnvFile(envVars, dbUrl) {
  const baseDir = process.env.VIBES_TMP_DIR || '/var/tmp';
  await fs.mkdir(baseDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(baseDir, 'vibes-env-'));
  const envPath = path.join(tempDir, 'app.env');
  const lines = [];
  if (dbUrl) lines.push(`DATABASE_URL=${dbUrl}`);
  for (const [key, value] of Object.entries(envVars || {})) {
    if (key === 'DATABASE_URL') continue;
    lines.push(`${key}=${value}`);
  }
  const contents = lines.join('\n');
  await fs.writeFile(envPath, contents);
  return { envPath, tempDir };
}

function localProjectRepoPath(projectId) {
  return path.join(LOCAL_PROJECT_REPO_ROOT, projectId);
}

async function localProjectRepoExists(projectId) {
  return fileExists(path.join(localProjectRepoPath(projectId), '.git'));
}

async function loadStoredProjectSource(projectId) {
  const result = await pool.query(
    `select repo_bundle_blob, snapshot_blob
       from projects
      where id = $1`,
    [projectId]
  );
  return result.rows[0] || null;
}

async function projectHasStoredRepoSource(projectId) {
  const result = await pool.query(
    `select repo_bundle_blob is not null as has_bundle,
            snapshot_blob is not null as has_snapshot
       from projects
      where id = $1`,
    [projectId]
  );
  return Boolean(result.rows[0]?.has_bundle || result.rows[0]?.has_snapshot);
}

const WORKSPACE_DB_FIELDS = [
  'pvc_name',
  'workspace_pod_name',
  'service_name',
  'preview_port',
  'install_command',
  'preview_command',
  'lockfile_hash',
  'state',
  'preview_mode',
  'current_commit_sha',
  'last_verified_commit_sha',
  'selected_mode',
  'selected_task_id',
  'selected_commit_sha',
  'live_task_id',
  'live_commit_sha',
  'full_build_image_ref',
  'full_build_commit_sha',
  'full_build_cache_key',
  'full_build_built_at',
  'workspace_dirty',
  'last_preview_heartbeat_at',
  'idle_expires_at',
  'snapshot_s3_key',
  'last_error'
];

let cachedWorkspaceImage = '';

function workspaceNamespace() {
  return 'vibes-development';
}

function workspaceNames(projectId) {
  const base = `vibes-workspace-${projectId}`;
  return {
    pvcName: `${base}-pvc`,
    podName: base,
    serviceName: base
  };
}

function extractKubernetesZoneValues(resource = null) {
  const terms = resource?.spec?.nodeAffinity?.required?.nodeSelectorTerms;
  const zones = new Set();
  if (!Array.isArray(terms)) return [];
  for (const term of terms) {
    for (const expr of term?.matchExpressions || []) {
      if (expr?.key !== 'topology.kubernetes.io/zone') continue;
      if (expr?.operator !== 'In') continue;
      for (const value of expr?.values || []) {
        const zone = String(value || '').trim();
        if (zone) zones.add(zone);
      }
    }
  }
  return Array.from(zones);
}

async function loadWorkspaceVolumeZones(namespace, pvcName) {
  if (!namespace || !pvcName) return [];
  try {
    const { stdout: pvcStdout } = await exec('kubectl', ['-n', namespace, 'get', 'pvc', pvcName, '-o', 'json']);
    const pvc = JSON.parse(pvcStdout || '{}');
    const volumeName = String(pvc?.spec?.volumeName || '').trim();
    if (!volumeName) return [];
    const { stdout: pvStdout } = await exec('kubectl', ['get', 'pv', volumeName, '-o', 'json']);
    const pv = JSON.parse(pvStdout || '{}');
    return extractKubernetesZoneValues(pv);
  } catch (err) {
    console.warn(
      `Workspace scheduling warning: failed to inspect volume zones for ${namespace}/${pvcName}; scheduling without node selector`,
      err?.message || err
    );
    return null;
  }
}

async function resolveWorkspaceNodePlacementBlock(namespace, pvcName) {
  if (!CUSTOMER_NODEGROUP_ENABLED) return '';
  const selector = `${CUSTOMER_NODEGROUP_LABEL}=${CUSTOMER_NODEGROUP_VALUE}`;
  let customerNodes = [];
  try {
    const { stdout } = await exec('kubectl', ['get', 'nodes', '-l', selector, '-o', 'json']);
    const payload = JSON.parse(stdout || '{}');
    customerNodes = Array.isArray(payload?.items) ? payload.items : [];
    if (!customerNodes.length) {
      console.warn(`Workspace scheduling warning: no nodes match ${selector}; scheduling without node selector`);
      return '';
    }
  } catch (err) {
    console.warn(
      `Workspace scheduling warning: failed to resolve nodes for ${selector}; scheduling without node selector`,
      err?.message || err
    );
    return '';
  }

  const customerZones = new Set(
    customerNodes
      .map((node) => String(node?.metadata?.labels?.['topology.kubernetes.io/zone'] || '').trim())
      .filter(Boolean)
  );
  const volumeZones = await loadWorkspaceVolumeZones(namespace, pvcName);
  if (volumeZones === null) return '';
  if (volumeZones.length) {
    const compatibleZones = volumeZones.filter((zone) => customerZones.has(zone));
    if (!compatibleZones.length) {
      console.warn(
        `Workspace scheduling warning: ${namespace}/${pvcName} is bound to zone(s) ${volumeZones.join(', ')} but customer nodes only exist in zone(s) ${Array.from(customerZones).join(', ') || 'unknown'}; scheduling without node selector`
      );
      return '';
    }
  }

  console.log(
    `Workspace scheduling: nodeSelector ${selector} taint ${CUSTOMER_NODEGROUP_TAINT_KEY}=${CUSTOMER_NODEGROUP_TAINT_VALUE}`
  );
  return [
    '  nodeSelector:',
    `    ${CUSTOMER_NODEGROUP_LABEL}: ${CUSTOMER_NODEGROUP_VALUE}`,
    '  tolerations:',
    `    - key: ${CUSTOMER_NODEGROUP_TAINT_KEY}`,
    '      operator: Equal',
    `      value: ${CUSTOMER_NODEGROUP_TAINT_VALUE}`,
    '      effect: NoSchedule'
  ].join('\n') + '\n';
}

function workspaceSnapshotKey(projectId, commitHash = 'latest') {
  const prefix = String(WORKSPACE_SNAPSHOT_PREFIX || 'project-workspaces').replace(/^\/+|\/+$/g, '');
  return `${prefix}/${projectId}/${commitHash || 'latest'}.tar.gz`;
}

function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function workspacePreviewInternalHost(projectId) {
  const { serviceName } = workspaceNames(projectId);
  return `${serviceName}.${workspaceNamespace()}.svc.cluster.local`;
}

async function applyManifest(namespace, manifest, fileName = 'manifest.yaml') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-manifest-'));
  const manifestPath = path.join(tempDir, fileName);
  await fs.writeFile(manifestPath, manifest);
  try {
    await exec('kubectl', ['-n', namespace, 'apply', '-f', manifestPath]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function deleteResource(namespace, kind, name) {
  try {
    await exec('kubectl', ['-n', namespace, 'delete', kind, name, '--ignore-not-found']);
  } catch (err) {
    console.warn(`Failed to delete ${kind}/${name} in ${namespace}`, err?.message || err);
  }
}

async function loadWorkspace(projectId, environment = 'development') {
  const result = await pool.query(
    'select * from project_workspaces where project_id = $1 and environment = $2',
    [projectId, environment]
  );
  return result.rows[0] || null;
}

async function environmentDeployedCommit(projectId, environment = 'development') {
  const result = await pool.query(
    'select deployed_commit from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  return result.rows[0]?.deployed_commit || '';
}

function normalizeDevelopmentMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['preview', 'workspace'].includes(mode)) return 'workspace';
  if (['full_build', 'full-build', 'verified'].includes(mode)) return 'verified';
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveWorkspaceField(patch, existing, key, fallback) {
  if (hasOwn(patch, key) && patch[key] !== undefined) return patch[key];
  if (existing?.[key] !== undefined) return existing[key];
  return fallback;
}

async function upsertWorkspace(projectId, patch = {}, environment = 'development') {
  const names = workspaceNames(projectId);
  const existing = await loadWorkspace(projectId, environment);
  const defaults = {
    pvc_name: names.pvcName,
    workspace_pod_name: names.podName,
    service_name: names.serviceName,
    preview_port: null,
    install_command: null,
    preview_command: null,
    lockfile_hash: null,
    state: 'starting',
    preview_mode: 'verified',
    current_commit_sha: null,
    last_verified_commit_sha: null,
    selected_mode: 'verified',
    selected_task_id: null,
    selected_commit_sha: null,
    live_task_id: null,
    live_commit_sha: null,
    full_build_image_ref: null,
    full_build_commit_sha: null,
    full_build_cache_key: null,
    full_build_built_at: null,
    workspace_dirty: false,
    last_preview_heartbeat_at: null,
    idle_expires_at: null,
    snapshot_s3_key: null,
    last_error: null
  };
  const next = {
    pvc_name: resolveWorkspaceField(patch, existing, 'pvc_name', defaults.pvc_name),
    workspace_pod_name: resolveWorkspaceField(patch, existing, 'workspace_pod_name', defaults.workspace_pod_name),
    service_name: resolveWorkspaceField(patch, existing, 'service_name', defaults.service_name),
    preview_port: resolveWorkspaceField(patch, existing, 'preview_port', defaults.preview_port),
    install_command: resolveWorkspaceField(patch, existing, 'install_command', defaults.install_command),
    preview_command: resolveWorkspaceField(patch, existing, 'preview_command', defaults.preview_command),
    lockfile_hash: resolveWorkspaceField(patch, existing, 'lockfile_hash', defaults.lockfile_hash),
    state: resolveWorkspaceField(patch, existing, 'state', defaults.state),
    preview_mode: resolveWorkspaceField(patch, existing, 'preview_mode', defaults.preview_mode),
    current_commit_sha: resolveWorkspaceField(patch, existing, 'current_commit_sha', defaults.current_commit_sha),
    last_verified_commit_sha: resolveWorkspaceField(
      patch,
      existing,
      'last_verified_commit_sha',
      defaults.last_verified_commit_sha
    ),
    selected_mode: resolveWorkspaceField(patch, existing, 'selected_mode', defaults.selected_mode),
    selected_task_id: resolveWorkspaceField(patch, existing, 'selected_task_id', defaults.selected_task_id),
    selected_commit_sha: resolveWorkspaceField(
      patch,
      existing,
      'selected_commit_sha',
      defaults.selected_commit_sha
    ),
    live_task_id: resolveWorkspaceField(patch, existing, 'live_task_id', defaults.live_task_id),
    live_commit_sha: resolveWorkspaceField(patch, existing, 'live_commit_sha', defaults.live_commit_sha),
    full_build_image_ref: resolveWorkspaceField(
      patch,
      existing,
      'full_build_image_ref',
      defaults.full_build_image_ref
    ),
    full_build_commit_sha: resolveWorkspaceField(
      patch,
      existing,
      'full_build_commit_sha',
      defaults.full_build_commit_sha
    ),
    full_build_cache_key: resolveWorkspaceField(
      patch,
      existing,
      'full_build_cache_key',
      defaults.full_build_cache_key
    ),
    full_build_built_at: resolveWorkspaceField(
      patch,
      existing,
      'full_build_built_at',
      defaults.full_build_built_at
    ),
    workspace_dirty: resolveWorkspaceField(patch, existing, 'workspace_dirty', defaults.workspace_dirty),
    last_preview_heartbeat_at: resolveWorkspaceField(
      patch,
      existing,
      'last_preview_heartbeat_at',
      defaults.last_preview_heartbeat_at
    ),
    idle_expires_at: resolveWorkspaceField(patch, existing, 'idle_expires_at', defaults.idle_expires_at),
    snapshot_s3_key: resolveWorkspaceField(patch, existing, 'snapshot_s3_key', defaults.snapshot_s3_key),
    last_error: resolveWorkspaceField(patch, existing, 'last_error', defaults.last_error)
  };
  const values = WORKSPACE_DB_FIELDS.map((field) => next[field]);
  await pool.query(
    `insert into project_workspaces (
       project_id, environment, ${WORKSPACE_DB_FIELDS.join(', ')}
     ) values (
       $1, $2, ${WORKSPACE_DB_FIELDS.map((_, idx) => `$${idx + 3}`).join(', ')}
     )
     on conflict (project_id, environment)
     do update set
       ${WORKSPACE_DB_FIELDS.map((field) => `${field} = excluded.${field}`).join(', ')},
       updated_at = now()`,
    [projectId, environment, ...values]
  );
  return loadWorkspace(projectId, environment);
}

async function getCurrentWorkerImage() {
  if (WORKSPACE_IMAGE) return WORKSPACE_IMAGE;
  if (cachedWorkspaceImage) return cachedWorkspaceImage;
  if (isLocalPlatform()) {
    cachedWorkspaceImage = 'node:20';
    return cachedWorkspaceImage;
  }
  const podName = process.env.HOSTNAME || '';
  if (!podName) {
    throw new Error('Cannot determine worker pod name for workspace image detection');
  }
  const { stdout } = await exec('kubectl', [
    '-n',
    WORKSPACE_POD_NAMESPACE,
    'get',
    'pod',
    podName,
    '-o',
    "jsonpath={.spec.containers[0].image}"
  ]);
  cachedWorkspaceImage = String(stdout || '').trim();
  if (!cachedWorkspaceImage) {
    throw new Error('Failed to detect current worker image');
  }
  return cachedWorkspaceImage;
}

async function ensureRdsCaBundleSecret(namespace) {
  const rdsCaPath = process.env.RDS_CA_PATH || '/etc/ssl/certs/rds-ca.pem';
  try {
    await fs.access(rdsCaPath);
  } catch {
    return;
  }
  const command = [
    'kubectl',
    '-n',
    namespace,
    'create',
    'secret',
    'generic',
    'rds-ca-bundle',
    `--from-file=rds-ca.pem=${rdsCaPath}`,
    '--dry-run=client',
    '-o',
    'yaml',
    '|',
    'kubectl',
    '-n',
    namespace,
    'apply',
    '-f',
    '-'
  ].join(' ');
  await exec('sh', ['-lc', command]);
}

async function workspaceExec(projectId, script, options = {}) {
  const namespace = workspaceNamespace();
  const workspace = (await loadWorkspace(projectId)) || workspaceNames(projectId);
  const podName = workspace.workspace_pod_name || workspace.podName || workspaceNames(projectId).podName;
  const args = ['-n', namespace, 'exec'];
  if (options.stdin) args.push('-i');
  args.push(podName, '-c', 'workspace', '--', 'sh', '-lc', script);
  return exec('kubectl', args, options.execOptions || {});
}

async function workspaceCopyToPod(projectId, localPath, remotePath) {
  const namespace = workspaceNamespace();
  const workspace = (await loadWorkspace(projectId)) || workspaceNames(projectId);
  const podName = workspace.workspace_pod_name || workspaceNames(projectId).podName;
  await exec('kubectl', [
    '-n',
    namespace,
    'cp',
    localPath,
    `${podName}:${remotePath}`,
    '-c',
    'workspace'
  ]);
}

async function workspaceCopyFromPod(projectId, remotePath, localPath) {
  const namespace = workspaceNamespace();
  const workspace = (await loadWorkspace(projectId)) || workspaceNames(projectId);
  const podName = workspace.workspace_pod_name || workspaceNames(projectId).podName;
  await exec('kubectl', [
    '-n',
    namespace,
    'cp',
    `${podName}:${remotePath}`,
    localPath,
    '-c',
    'workspace'
  ]);
}

async function ensureWorkspaceService(projectId, previewPort = WORKSPACE_SERVICE_PORT) {
  const namespace = workspaceNamespace();
  const { serviceName } = workspaceNames(projectId);
  const manifest = `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
spec:
  selector:
    app: ${serviceName}
  ports:
    - name: http
      port: ${WORKSPACE_SERVICE_CLUSTER_PORT}
      targetPort: ${previewPort}
`;
  await applyManifest(namespace, manifest, `${serviceName}-service.yaml`);
}

async function ensureWorkspacePod(projectId, previewPort = WORKSPACE_SERVICE_PORT) {
  const namespace = workspaceNamespace();
  const { pvcName, podName, serviceName } = workspaceNames(projectId);
  const storageClassBlock = WORKSPACE_STORAGE_CLASS
    ? `  storageClassName: ${WORKSPACE_STORAGE_CLASS}\n`
    : '';
  const nodePlacementBlock = await resolveWorkspaceNodePlacementBlock(namespace, pvcName);
  const image = await getCurrentWorkerImage();
  await exec('sh', ['-lc', `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`]);
  await ensureRdsCaBundleSecret(namespace);
  const pvcManifest = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
spec:
  accessModes:
    - ReadWriteOnce
${storageClassBlock}  resources:
    requests:
      storage: ${WORKSPACE_STORAGE_SIZE}
`;
  await applyManifest(namespace, pvcManifest, `${pvcName}.yaml`);
  try {
    const { stdout } = await exec('kubectl', [
      '-n',
      namespace,
      'get',
      'pod',
      podName,
      '-o',
      'jsonpath={.status.phase}'
    ]);
    if (String(stdout || '').trim().toLowerCase() !== 'running') {
      await deleteResource(namespace, 'pod', podName);
    }
  } catch {}

  const podManifest = `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  labels:
    app: ${serviceName}
    vibes/project-id: "${projectId}"
spec:
${nodePlacementBlock}  restartPolicy: Always
  containers:
    - name: workspace
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["node", "/app/worker/src/workspace-agent.js"]
      env:
        - name: WORKSPACE_AGENT_HEARTBEAT_MS
          value: "5000"
        - name: PGSSLROOTCERT
          value: /etc/ssl/certs/rds-ca.pem
        - name: NODE_EXTRA_CA_CERTS
          value: /etc/ssl/certs/rds-ca.pem
      resources:
        requests:
          cpu: ${WORKSPACE_POD_CPU_REQUEST}
          memory: ${WORKSPACE_POD_MEM_REQUEST}
        limits:
          cpu: ${WORKSPACE_POD_CPU_LIMIT}
          memory: ${WORKSPACE_POD_MEM_LIMIT}
      volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: rds-ca
          mountPath: /etc/ssl/certs/rds-ca.pem
          subPath: rds-ca.pem
          readOnly: true
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: ${pvcName}
    - name: rds-ca
      secret:
        secretName: rds-ca-bundle
        items:
          - key: rds-ca.pem
            path: rds-ca.pem
`;
  await applyManifest(namespace, podManifest, `${podName}.yaml`);
  await ensureWorkspaceService(projectId, previewPort);
  await exec('kubectl', [
    '-n',
    namespace,
    'wait',
    '--for=condition=Ready',
    `pod/${podName}`,
    '--timeout=180s'
  ]);
  return upsertWorkspace(projectId, {
    pvc_name: pvcName,
    workspace_pod_name: podName,
    service_name: serviceName,
    preview_port: previewPort,
    state: 'starting'
  });
}

async function replaceWorkspaceContents(projectId, sourceDir) {
  await ensureWorkspacePod(projectId);
  await workspaceExec(
    projectId,
    `set -eu
mkdir -p ${shellEscape(WORKSPACE_ROOT_PATH)} ${shellEscape(WORKSPACE_META_PATH)}
find ${shellEscape(WORKSPACE_ROOT_PATH)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`
  );
  await workspaceCopyToPod(projectId, `${sourceDir}/.`, WORKSPACE_ROOT_PATH);
}

async function hydrateWorkspaceFromStoredRepo(projectId) {
  const { repoPath, tempDir } = await loadRepoFromStoredSource(projectId);
  try {
    await replaceWorkspaceContents(projectId, repoPath);
    await workspaceExec(
      projectId,
      `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git config user.name ${shellEscape(AUTHOR_NAME)}
git config user.email ${shellEscape(AUTHOR_EMAIL)}
git checkout -B main >/dev/null 2>&1 || true
mkdir -p ${shellEscape(WORKSPACE_META_PATH)}
date -u +"%Y-%m-%dT%H:%M:%SZ" > ${shellEscape(path.posix.join(WORKSPACE_META_PATH, 'hydrated_at'))}`
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function cloneStarterIntoWorkspace(projectId) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-workspace-starter-'));
  const repoDir = path.join(tempDir, 'repo');
  try {
    await cloneStarterRepo(repoDir);
    await replaceWorkspaceContents(projectId, repoDir);
    await workspaceExec(
      projectId,
      `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git checkout -B main >/dev/null 2>&1 || true
mkdir -p ${shellEscape(WORKSPACE_META_PATH)}
date -u +"%Y-%m-%dT%H:%M:%SZ" > ${shellEscape(path.posix.join(WORKSPACE_META_PATH, 'hydrated_at'))}`
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function detectWorkspaceCommands(projectId, envVars = {}) {
  await ensureWorkspacePod(projectId);
  const { stdout } = await workspaceExec(
    projectId,
    `node /app/worker/src/workspace-inspect.js ${shellEscape(WORKSPACE_ROOT_PATH)}`
  );
  const detected = JSON.parse(stdout || '{}');
  const previewCommand =
    String(envVars.VIBES_PREVIEW_COMMAND || '').trim() ||
    detected.previewCommand ||
    null;
  const installCommand =
    String(envVars.VIBES_INSTALL_COMMAND || '').trim() ||
    detected.installCommand ||
    null;
  const previewPort =
    Number(envVars.VIBES_PREVIEW_PORT || detected.previewPort || WORKSPACE_SERVICE_PORT) ||
    WORKSPACE_SERVICE_PORT;
  await ensureWorkspaceService(projectId, previewPort);
  return {
    ...detected,
    previewCommand,
    installCommand,
    previewPort,
    unsupported: !previewCommand
  };
}

async function getDevelopmentRuntimeContext(projectId) {
  const envRes = await pool.query(
    'select env_vars, db_url, db_name from environments where project_id = $1 and name = $2',
    [projectId, 'development']
  );
  const projectRes = await pool.query(
    'select id, name, short_id, project_slug from projects where id = $1',
    [projectId]
  );
  const project = projectRes.rows[0];
  if (!project?.short_id) throw new Error('Project not found');
  const envVars = envRes.rows[0]?.env_vars || {};
  let dbUrl = envRes.rows[0]?.db_url || null;
  const dbName = envRes.rows[0]?.db_name || dbNameFor(project.short_id, 'development');
  if (!dbUrl || !dbUrlMatchesConfig(dbUrl)) {
    await ensureDatabase(dbName);
    dbUrl = dbUrlFor(dbName);
    await pool.query(
      `insert into environments (project_id, name, db_name, db_url)
       values ($1, $2, $3, $4)
       on conflict (project_id, name)
       do update set db_name = excluded.db_name, db_url = excluded.db_url`,
      [projectId, 'development', dbName, dbUrl]
    );
  }
  return { project, envVars, dbUrl, dbName };
}

function workspaceCacheEnvScript() {
  const cacheRoot = path.posix.join(WORKSPACE_META_PATH, 'cache');
  return [
    `mkdir -p ${shellEscape(cacheRoot)}`,
    `export CI=false`,
    `export NPM_CONFIG_CACHE=${shellEscape(path.posix.join(cacheRoot, 'npm'))}`,
    `export PNPM_HOME=${shellEscape(path.posix.join(cacheRoot, 'pnpm-home'))}`,
    `export PNPM_STORE_DIR=${shellEscape(path.posix.join(cacheRoot, 'pnpm-store'))}`,
    `export YARN_CACHE_FOLDER=${shellEscape(path.posix.join(cacheRoot, 'yarn'))}`,
    `export BUN_INSTALL_CACHE_DIR=${shellEscape(path.posix.join(cacheRoot, 'bun'))}`
  ].join('\n');
}

async function isWorkspacePreviewHealthy(projectId, previewPort = WORKSPACE_SERVICE_PORT) {
  const clusterPort = Number(WORKSPACE_SERVICE_CLUSTER_PORT || 80) || 80;
  const previewUrl = `http://${workspacePreviewInternalHost(projectId)}:${clusterPort}${healthcheckPathForEnv('development')}`;
  const health = await checkUrlHealthy(previewUrl);
  return health.ok;
}

async function ensureWorkspaceDependencies(projectId, workspaceRow, envVars = {}) {
  const detected = await detectWorkspaceCommands(projectId, envVars);
  if (!detected.installCommand) {
    await upsertWorkspace(projectId, {
      ...workspaceRow,
      preview_port: detected.previewPort,
      preview_command: detected.previewCommand,
      install_command: null,
      lockfile_hash: detected.lockfileHash || null
    });
    return {
      ...detected,
      didInstall: false,
      needsRestart:
        workspaceRow?.preview_command !== detected.previewCommand ||
        Number(workspaceRow?.preview_port || 0) !== Number(detected.previewPort || 0)
    };
  }
  const shouldInstall =
    Boolean(detected.needsInstall) ||
    !workspaceRow?.lockfile_hash ||
    workspaceRow.lockfile_hash !== detected.lockfileHash ||
    workspaceRow.install_command !== detected.installCommand;
  let didInstall = false;
  if (shouldInstall) {
    await workspaceExec(
      projectId,
      `set -eu
${workspaceCacheEnvScript()}
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
${detected.installCommand}`
    );
    didInstall = true;
  }
  await upsertWorkspace(projectId, {
    ...workspaceRow,
    preview_port: detected.previewPort,
    preview_command: detected.previewCommand,
    install_command: detected.installCommand,
      lockfile_hash: detected.lockfileHash || null,
      last_error: detected.unsupported ? 'Preview command not detected for workspace' : null
  });
  return {
    ...detected,
    didInstall,
    needsRestart:
      didInstall ||
      workspaceRow?.preview_command !== detected.previewCommand ||
      Number(workspaceRow?.preview_port || 0) !== Number(detected.previewPort || 0)
  };
}

async function workspaceGitOutput(projectId, args) {
  const command = ['git', ...args.map((arg) => shellEscape(arg))].join(' ');
  const { stdout } = await workspaceExec(projectId, `cd ${shellEscape(WORKSPACE_ROOT_PATH)} && ${command}`);
  return String(stdout || '').trim();
}

async function workspaceCurrentCommit(projectId) {
  try {
    return await workspaceGitOutput(projectId, ['rev-parse', 'HEAD']);
  } catch {
    return '';
  }
}

async function workspaceHasCommit(projectId, commitHash) {
  if (!commitHash) return false;
  try {
    await workspaceGitOutput(projectId, ['rev-parse', '--verify', `${commitHash}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function workspaceIsDirty(projectId) {
  try {
    const { stdout } = await workspaceExec(
      projectId,
      `cd ${shellEscape(WORKSPACE_ROOT_PATH)} && git status --porcelain`
    );
    const lines = String(stdout || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const relevant = lines.filter((line) => {
      let filePath = line.slice(3).trim();
      if (!filePath) return false;
      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ').pop()?.trim() || filePath;
      }
      return !(
        filePath === '.codex-last-message.txt' ||
        filePath === 'npm-debug.log' ||
        filePath === 'yarn-error.log' ||
        filePath.startsWith('.vibes/') ||
        filePath.startsWith('.next/') ||
        filePath.startsWith('node_modules/') ||
        filePath.startsWith('dist/') ||
        filePath.startsWith('build/') ||
        filePath.startsWith('coverage/') ||
        filePath.startsWith('.expo/') ||
        filePath.startsWith('.turbo/')
      );
    });
    return relevant.length > 0;
  } catch {
    return false;
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortJsonValue(value[key]);
      return acc;
    }, {});
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortJsonValue(value))).digest('hex');
}

async function branchHeadFromRepo(repoPath, branchName) {
  try {
    return await gitOutput(['rev-parse', '--verify', `${branchName}^{commit}`], repoPath);
  } catch {
    return '';
  }
}

async function resolvePreferredDevelopmentCommit(projectId) {
  if (!isLocalPlatform()) {
    const workspace = await loadWorkspace(projectId);
    if (workspace) {
      const aiHead = await workspaceGitOutput(projectId, ['rev-parse', '--verify', 'ai-task^{commit}']).catch(() => '');
      if (aiHead) return aiHead;
      const mainHead = await workspaceGitOutput(projectId, ['rev-parse', '--verify', 'main^{commit}']).catch(() => '');
      if (mainHead) return mainHead;
      const currentHead = await workspaceCurrentCommit(projectId);
      if (currentHead) return currentHead;
    }
  } else if (await localProjectRepoExists(projectId)) {
    const repoPath = localProjectRepoPath(projectId);
    const aiHead = await branchHeadFromRepo(repoPath, 'ai-task');
    if (aiHead) return aiHead;
    const mainHead = await branchHeadFromRepo(repoPath, 'main');
    if (mainHead) return mainHead;
    return await gitOutput(['rev-parse', 'HEAD'], repoPath).catch(() => '');
  }
  const { repoPath, tempDir } = await loadRepoFromStoredSource(projectId);
  try {
    const aiHead = await branchHeadFromRepo(repoPath, 'ai-task');
    if (aiHead) return aiHead;
    const mainHead = await branchHeadFromRepo(repoPath, 'main');
    if (mainHead) return mainHead;
    return await gitOutput(['rev-parse', 'HEAD'], repoPath).catch(() => '');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveSelectedDevelopmentTarget(projectId, overrides = {}) {
  const workspace = await loadWorkspace(projectId);
  let mode =
    normalizeDevelopmentMode(overrides.mode)
    || normalizeDevelopmentMode(workspace?.selected_mode)
    || normalizeDevelopmentMode(workspace?.preview_mode)
    || 'workspace';
  let taskId = Object.prototype.hasOwnProperty.call(overrides, 'taskId')
    ? (overrides.taskId || null)
    : (workspace?.selected_task_id || null);
  let commitHash = Object.prototype.hasOwnProperty.call(overrides, 'commitHash')
    ? String(overrides.commitHash || '').trim() || null
    : (workspace?.selected_commit_sha || null);
  if (!commitHash) {
    commitHash = await resolvePreferredDevelopmentCommit(projectId);
    taskId = null;
    await upsertWorkspace(projectId, {
      selected_mode: mode,
      selected_task_id: null,
      selected_commit_sha: commitHash || null
    });
  } else if (
    normalizeDevelopmentMode(workspace?.selected_mode) !== mode ||
    String(workspace?.selected_task_id || '') !== String(taskId || '') ||
    String(workspace?.selected_commit_sha || '') !== String(commitHash || '')
  ) {
    await upsertWorkspace(projectId, {
      selected_mode: mode,
      selected_task_id: taskId,
      selected_commit_sha: commitHash
    });
  }
  return {
    mode,
    taskId,
    commitHash: commitHash || ''
  };
}

async function checkoutWorkspaceCommit(projectId, commitHash) {
  if (!commitHash) throw new Error('Commit hash required for workspace checkout');
  let workspace = await ensureWorkspace(projectId, { state: 'ready' });
  let targetAvailable = await workspaceHasCommit(projectId, commitHash);
  if (!targetAvailable) {
    const hasStoredRepo = await projectHasStoredRepoSource(projectId);
    workspace = await ensureWorkspace(projectId, {
      hydrateFromStoredRepo: hasStoredRepo,
      cloneStarter: !hasStoredRepo,
      state: 'ready'
    });
    targetAvailable = await workspaceHasCommit(projectId, commitHash);
  }
  if (!targetAvailable) {
    throw new Error(`Commit ${commitHash} is unavailable in the development workspace`);
  }
  await workspaceExec(
    projectId,
    `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git reset --hard >/dev/null 2>&1 || true
git clean -fdx >/dev/null 2>&1 || true
git checkout -f -B vibes-preview ${shellEscape(commitHash)} >/dev/null 2>&1
git reset --hard ${shellEscape(commitHash)} >/dev/null 2>&1
git clean -fdx >/dev/null 2>&1`
  );
  await upsertWorkspace(projectId, {
    state: 'ready',
    current_commit_sha: commitHash,
    workspace_dirty: false,
    last_error: null
  });
  return commitHash;
}

async function exportCommitArchive(projectId, commitHash) {
  if (!isLocalPlatform()) {
    const workspace = await loadWorkspace(projectId);
    if (workspace && await workspaceHasCommit(projectId, commitHash)) {
      return exportWorkspaceSnapshot(projectId, commitHash);
    }
  } else if (await localProjectRepoExists(projectId)) {
    const loaded = await cloneRepoToTemp(localProjectRepoPath(projectId));
    try {
      if (commitHash) {
        try {
          await runGit(['checkout', commitHash], loaded.repoPath);
        } catch {
          throw new Error(`Commit ${commitHash} is unavailable for full build`);
        }
      }
      const archived = await createSnapshotArchive(loaded.repoPath, `cache-${commitHash || 'current'}`);
      return {
        snapshotPath: archived.archivePath,
        tempDir: archived.archiveDir,
        commitHash: commitHash || await gitOutput(['rev-parse', 'HEAD'], loaded.repoPath).catch(() => commitHash || '')
      };
    } finally {
      await fs.rm(loaded.tempDir, { recursive: true, force: true });
    }
  }
  const loaded = await loadRepoFromStoredSource(projectId);
  try {
    if (commitHash) {
      try {
        await runGit(['checkout', commitHash], loaded.repoPath);
      } catch (err) {
        throw new Error(`Commit ${commitHash} is unavailable for full build`);
      }
    }
    const archived = await createSnapshotArchive(loaded.repoPath, `cache-${commitHash || 'current'}`);
    await fs.rm(loaded.tempDir, { recursive: true, force: true });
    return {
      snapshotPath: archived.archivePath,
      tempDir: archived.archiveDir,
      commitHash: commitHash || await gitOutput(['rev-parse', 'HEAD'], loaded.repoPath).catch(() => commitHash || '')
    };
  } catch (err) {
    await fs.rm(loaded.tempDir, { recursive: true, force: true });
    throw err;
  }
}

async function computeDevelopmentFullBuildCacheMeta(projectId, commitHash) {
  if (!commitHash) {
    return { cacheKey: '', envFingerprint: '', snapshotHash: '', buildFingerprint: '', imageRef: '' };
  }
  const runtime = await getDevelopmentRuntimeContext(projectId);
  const archive = await exportCommitArchive(projectId, commitHash);
  try {
    const snapshotHash = await hashFile(archive.snapshotPath);
    const envFingerprint = hashJson(runtime.envVars || {});
    const buildFingerprint = hashJson({
      deployCommand: deployCommandForEnv('development') || '',
      workerImage: await getCurrentWorkerImage().catch(() => ''),
      workspaceLockfileHash: (await loadWorkspace(projectId))?.lockfile_hash || ''
    });
    return {
      cacheKey: hashJson({
        commitHash,
        snapshotHash,
        envFingerprint,
        buildFingerprint
      }),
      envFingerprint,
      snapshotHash,
      buildFingerprint,
      imageRef: ''
    };
  } finally {
    await fs.rm(archive.tempDir, { recursive: true, force: true });
  }
}

function imageRefForBuild(projectId, environment, deployTag) {
  const region = String(process.env.AWS_REGION || '').trim();
  const account = String(process.env.AWS_ACCOUNT_ID || '').trim();
  const repo = String(process.env.ECR_REPO || '').trim();
  if (!region || !account || !repo || !deployTag) return '';
  return `${account}.dkr.ecr.${region}.amazonaws.com/${repo}:${deployTag}`;
}

function deployTagForBuild(commitHash, buildId) {
  let deployTag = commitHash || '';
  if (!deployTag || !buildId) return deployTag;
  const suffix = String(buildId).replace(/[^a-zA-Z0-9]+/g, '').slice(0, 12);
  if (!suffix) return deployTag;
  return `${deployTag}-${suffix}`;
}

async function stopWorkspacePreview(projectId) {
  try {
    await workspaceExec(
      projectId,
      `set +e
PID_FILE=${shellEscape(path.posix.join(WORKSPACE_META_PATH, 'preview.pid'))}
list_preview_pids() {
  (ps -o pid= -o args= 2>/dev/null || busybox ps -o pid= -o args= 2>/dev/null || true) | while read -r PID CMD; do
    [ -n "$PID" ] || continue
    [ "$PID" = "1" ] && continue
    case "$CMD" in
      *workspace-agent.js*|*workspace-codex-runner.js*|*busybox\ ps*|*sh\ -lc\ ps\ -o\ pid=*|*sh\ -lc\ set\ +e*)
        continue
        ;;
    esac
    case "$CMD" in
      "node"|\
      "node index.js"|\
      "node server/index.js"|\
      "npm run start"|\
      "npm run start "*|\
      "npm run dev"|\
      "npm run dev "*|\
      *"/node_modules/.bin/next dev"*|\
      "next-server "*|\
      *"/node_modules/vite/"*|\
      *"vite --host "*|\
      *"astro dev"*|\
      *"webpack serve"*|\
      *"parcel"*)
        echo "$PID"
        ;;
    esac
  done | sort -u
}

stop_pid() {
  TARGET="$1"
  [ -n "$TARGET" ] || return 0
  kill -TERM "$TARGET" >/dev/null 2>&1 || true
  kill -TERM "-$TARGET" >/dev/null 2>&1 || true
}

kill_pid_force() {
  TARGET="$1"
  [ -n "$TARGET" ] || return 0
  kill -9 "$TARGET" >/dev/null 2>&1 || true
  kill -9 "-$TARGET" >/dev/null 2>&1 || true
}

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    stop_pid "$PID"
  fi
  rm -f "$PID_FILE"
fi

PREVIEW_PIDS="$(list_preview_pids)"
for PID in $PREVIEW_PIDS; do
  stop_pid "$PID"
done
sleep 2
for PID in $PREVIEW_PIDS; do
  kill_pid_force "$PID"
done`
    );
  } catch {}
}

async function startWorkspacePreview(projectId, options = {}) {
  const failurePreviewMode = options.failurePreviewMode || 'verified';
  const runtime = await getDevelopmentRuntimeContext(projectId);
  const workspaceRow = await loadWorkspace(projectId);
  const detected = await ensureWorkspaceDependencies(projectId, workspaceRow, runtime.envVars);
  if (detected.unsupported || !detected.previewCommand) {
    await upsertWorkspace(projectId, {
      preview_mode: failurePreviewMode,
      state: 'failed',
      preview_port: detected.previewPort,
      preview_command: detected.previewCommand,
      install_command: detected.installCommand,
      lockfile_hash: detected.lockfileHash || null,
      last_error: 'Preview command not detected for workspace'
    });
    return { started: false, reason: 'unsupported' };
  }
  const currentCommit = await workspaceCurrentCommit(projectId);
  const dirty = await workspaceIsDirty(projectId);
  const reuseExisting =
    !options.forceRestart &&
    !detected.needsRestart &&
    await isWorkspacePreviewHealthy(projectId, detected.previewPort);
  if (reuseExisting) {
    await upsertWorkspace(projectId, {
      preview_mode: 'workspace',
      state: 'ready',
      preview_port: detected.previewPort,
      preview_command: detected.previewCommand,
      install_command: detected.installCommand,
      lockfile_hash: detected.lockfileHash || null,
      current_commit_sha: currentCommit || null,
      workspace_dirty: dirty,
      last_preview_heartbeat_at: new Date(),
      idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS),
      last_error: null
    });
    return {
      started: true,
      reused: true,
      previewPort: detected.previewPort,
      commitSha: currentCommit
    };
  }
  await stopWorkspacePreview(projectId);
  const envEntries = Object.entries({
    ...runtime.envVars,
    DATABASE_URL: runtime.dbUrl || '',
    PORT: String(detected.previewPort),
    HOST: '0.0.0.0',
    NODE_ENV: 'development',
    BABEL_ENV: 'development',
    PGSSLROOTCERT: '/etc/ssl/certs/rds-ca.pem',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/rds-ca.pem'
  }).filter(([, value]) => value !== undefined && value !== null && value !== '');
  const envScript = envEntries
    .map(([key, value]) => `export ${key}=${shellEscape(String(value))}`)
    .join('\n');
  await workspaceExec(
    projectId,
    `set -eu
mkdir -p ${shellEscape(WORKSPACE_META_PATH)}
LOG_FILE=${shellEscape(path.posix.join(WORKSPACE_META_PATH, 'preview.log'))}
PID_FILE=${shellEscape(path.posix.join(WORKSPACE_META_PATH, 'preview.pid'))}
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
${workspaceCacheEnvScript()}
${envScript}
nohup sh -lc ${shellEscape(`set -e\n${detected.previewCommand}`)} > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"`
  );
  const previewUrl = `http://${workspacePreviewInternalHost(projectId)}:${WORKSPACE_SERVICE_CLUSTER_PORT}${healthcheckPathForEnv('development')}`;
  const healthy = await waitForUrlHealthy(previewUrl, options.timeoutMs || WORKSPACE_PREVIEW_START_TIMEOUT_MS);
  if (!healthy) {
    await upsertWorkspace(projectId, {
      preview_mode: failurePreviewMode,
      state: 'failed',
      preview_port: detected.previewPort,
      preview_command: detected.previewCommand,
      install_command: detected.installCommand,
      lockfile_hash: detected.lockfileHash || null,
      last_error: 'Workspace preview failed to become healthy'
    });
    throw new Error('Workspace preview failed to become healthy');
  }
  await upsertWorkspace(projectId, {
    preview_mode: 'workspace',
    state: 'ready',
    preview_port: detected.previewPort,
    preview_command: detected.previewCommand,
    install_command: detected.installCommand,
    lockfile_hash: detected.lockfileHash || null,
    current_commit_sha: currentCommit || null,
    workspace_dirty: dirty,
    last_preview_heartbeat_at: new Date(),
    idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS),
    last_error: null
  });
  return {
    started: true,
    reused: false,
    previewPort: detected.previewPort,
    commitSha: currentCommit
  };
}

async function exportWorkspaceSnapshot(projectId, commitHash = '') {
  const targetCommit = commitHash || (await workspaceCurrentCommit(projectId));
  if (!targetCommit) throw new Error('Workspace commit unavailable');
  const remotePath = `/tmp/workspace-${projectId}-${Date.now()}.tar.gz`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-workspace-export-'));
  const snapshotPath = path.join(tempDir, 'workspace.tar.gz');
  try {
    await workspaceExec(
      projectId,
      `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git archive --format=tar.gz -o ${shellEscape(remotePath)} ${shellEscape(targetCommit)}`
    );
    await workspaceCopyFromPod(projectId, remotePath, snapshotPath);
    return { snapshotPath, tempDir, commitHash: targetCommit };
  } finally {
    try {
      await workspaceExec(projectId, `rm -f ${shellEscape(remotePath)}`);
    } catch {}
  }
}

async function exportWorkspaceRepoBundle(projectId) {
  const remotePath = `/tmp/workspace-${projectId}-${Date.now()}.bundle`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-workspace-bundle-'));
  const bundlePath = path.join(tempDir, 'repo.bundle');
  try {
    await workspaceExec(
      projectId,
      `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git bundle create ${shellEscape(remotePath)} --all`
    );
    await workspaceCopyFromPod(projectId, remotePath, bundlePath);
    return { bundlePath, tempDir };
  } finally {
    try {
      await workspaceExec(projectId, `rm -f ${shellEscape(remotePath)}`);
    } catch {}
  }
}

async function syncRepoBundleFromWorkspace(projectId) {
  const exported = await exportWorkspaceRepoBundle(projectId);
  try {
    await persistRepoBundleBlob(projectId, exported.bundlePath);
    return workspaceCurrentCommit(projectId);
  } finally {
    await fs.rm(exported.tempDir, { recursive: true, force: true });
  }
}

function workspaceAutoDnsEnabled() {
  return Boolean(process.env.AUTO_DNS) && String(process.env.AUTO_DNS).toLowerCase() !== 'false';
}

function workspaceRoute53Domain(appHost) {
  const explicit = normalizeDomain(process.env.ROUTE53_DOMAIN || process.env.APP_DOMAIN || process.env.DOMAIN);
  if (explicit) return explicit.replace(/\.$/, '');
  return String(appHost || '').replace(/^.+?\./, '').replace(/\.$/, '');
}

async function waitForIngressAlbHostname(namespace, ingressName) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const { stdout } = await exec('kubectl', [
        '-n',
        namespace,
        'get',
        'ingress',
        ingressName,
        '-o',
        'jsonpath={.status.loadBalancer.ingress[0].hostname}'
      ]);
      const hostname = String(stdout || '').trim();
      if (hostname) return hostname;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return '';
}

async function applyIngressDnsRecord(appHost, ingressName) {
  if (!workspaceAutoDnsEnabled() || isLocalPlatform()) return;
  const route53Domain = workspaceRoute53Domain(appHost);
  let hostedZoneId = String(process.env.ROUTE53_HOSTED_ZONE_ID || '').trim();
  if (!hostedZoneId) {
    if (!route53Domain) return;
    const { stdout } = await exec('aws', [
      'route53',
      'list-hosted-zones-by-name',
      '--dns-name',
      route53Domain,
      '--max-items',
      '1',
      '--output',
      'json'
    ]);
    const payload = JSON.parse(stdout || '{}');
    hostedZoneId = String(payload?.HostedZones?.[0]?.Id || '').replace(/^\/hostedzone\//, '').trim();
  }
  if (!hostedZoneId) return;

  const albDns = await waitForIngressAlbHostname(workspaceNamespace(), ingressName);
  if (!albDns) return;

  const region = process.env.AWS_REGION || 'us-east-1';
  const { stdout } = await exec('aws', ['elbv2', 'describe-load-balancers', '--region', region, '--output', 'json']);
  const payload = JSON.parse(stdout || '{}');
  const loadBalancer = (payload?.LoadBalancers || []).find((item) => item?.DNSName === albDns);
  const albHostedZoneId = String(loadBalancer?.CanonicalHostedZoneId || '').trim();
  if (!albHostedZoneId) return;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-route53-'));
  const changePath = path.join(tempDir, 'change.json');
  const changeBatch = {
    Comment: `Route ${appHost} to ALB`,
    Changes: [
      {
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: `${appHost}.`,
          Type: 'A',
          AliasTarget: {
            HostedZoneId: albHostedZoneId,
            DNSName: `${albDns}.`,
            EvaluateTargetHealth: false
          }
        }
      }
    ]
  };
  try {
    await fs.writeFile(changePath, JSON.stringify(changeBatch));
    await exec('aws', [
      'route53',
      'change-resource-record-sets',
      '--hosted-zone-id',
      hostedZoneId,
      '--change-batch',
      `file://${changePath}`
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function applyDevelopmentIngress(projectId, serviceName, appHost) {
  if (isLocalPlatform()) return;
  if (!process.env.ACM_CERT_ARN) {
    throw new Error('ACM_CERT_ARN required for development ingress');
  }
  const namespace = workspaceNamespace();
  const appName = `vibes-app-${projectId}`;
  const groupName = process.env.ALB_GROUP_NAME || 'vibes-shared';
  const groupOrder = process.env.ALB_GROUP_ORDER || '50';
  const healthPath = healthcheckPathForEnv('development');
  const manifest = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${appName}
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: ${process.env.ACM_CERT_ARN}
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: ${healthPath}
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: '${process.env.ALB_HEALTHCHECK_INTERVAL_SECONDS || '15'}'
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: '${process.env.ALB_HEALTHCHECK_TIMEOUT_SECONDS || '5'}'
    alb.ingress.kubernetes.io/healthy-threshold-count: '${process.env.ALB_HEALTHY_THRESHOLD_COUNT || '2'}'
    alb.ingress.kubernetes.io/unhealthy-threshold-count: '${process.env.ALB_UNHEALTHY_THRESHOLD_COUNT || '2'}'
    alb.ingress.kubernetes.io/success-codes: '200-399'
    alb.ingress.kubernetes.io/group.name: ${groupName}
    alb.ingress.kubernetes.io/group.order: '${groupOrder}'
spec:
  ingressClassName: alb
  rules:
    - host: ${appHost}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${serviceName}
                port:
                  number: ${WORKSPACE_SERVICE_CLUSTER_PORT}
`;
  await applyManifest(namespace, manifest, `${appName}-ingress.yaml`);
  try {
    await applyIngressDnsRecord(appHost, appName);
  } catch (err) {
    console.warn(`Development DNS update failed for ${appHost}`, err?.message || err);
  }
}

async function switchDevelopmentRoute(projectId, target = 'workspace') {
  if (isLocalPlatform()) return;
  const projectRes = await pool.query('select name, short_id, project_slug from projects where id = $1', [projectId]);
  const project = projectRes.rows[0];
  if (!project) throw new Error('Project not found');
  const workspace = await loadWorkspace(projectId);
  const serviceName =
    target === 'workspace'
      ? (workspace?.service_name || workspaceNames(projectId).serviceName)
      : `vibes-app-${projectId}`;
  await applyDevelopmentIngress(projectId, serviceName, hostFor(project, 'development'));
  await upsertWorkspace(projectId, { preview_mode: target === 'workspace' ? 'workspace' : 'verified' });
}

async function markDevelopmentPreviewLive(projectId, commitHash) {
  const resolvedCommit = commitHash || (await workspaceCurrentCommit(projectId).catch(() => null));
  await updateBuildStatus(projectId, 'development', 'live', resolvedCommit || null);
  return resolvedCommit || null;
}

async function ensureDevelopmentWorkspace(projectId, options = {}) {
  const existingWorkspace = await loadWorkspace(projectId);
  const hasStoredRepo = await projectHasStoredRepoSource(projectId);
  return ensureWorkspace(projectId, {
    hydrateFromStoredRepo: !existingWorkspace && hasStoredRepo,
    cloneStarter: !existingWorkspace && !hasStoredRepo && Boolean(options.cloneStarter),
    state: options.state || 'ready'
  });
}

async function resumeDevelopmentPreview(projectId, options = {}) {
  if (isLocalPlatform()) return { started: false, reason: 'local' };
  await ensureDevelopmentWorkspace(projectId, { state: 'ready' });
  const preview = await startWorkspacePreview(projectId, {
    forceRestart: Boolean(options.forceRestart),
    failurePreviewMode: 'workspace'
  });
  if (!preview.started) {
    throw new Error('Preview command not detected for workspace');
  }
  await switchDevelopmentRoute(projectId, 'workspace');
  const liveCommit = await markDevelopmentPreviewLive(projectId, preview.commitSha || null);
  const workspaceSelection = await loadWorkspace(projectId);
  await upsertWorkspace(projectId, {
    state: 'ready',
    preview_mode: 'workspace',
    selected_mode: normalizeDevelopmentMode(workspaceSelection?.selected_mode) || 'workspace',
    current_commit_sha: preview.commitSha || null,
    selected_task_id: workspaceSelection?.selected_task_id || null,
    selected_commit_sha: workspaceSelection?.selected_commit_sha || preview.commitSha || null,
    live_task_id:
      workspaceSelection?.selected_commit_sha &&
      workspaceSelection.selected_commit_sha === (liveCommit || preview.commitSha || null)
        ? (workspaceSelection.selected_task_id || null)
        : null,
    live_commit_sha: liveCommit || preview.commitSha || null,
    workspace_dirty: await workspaceIsDirty(projectId).catch(() => false),
    idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS),
    last_error: null
  });
  emitProjectEvent(projectId, 'workspaceUpdated', {
    projectId,
    state: 'ready',
    preview_mode: 'workspace',
    commit_sha: liveCommit
  });
  return {
    started: true,
    commitSha: liveCommit
  };
}

async function verifyDevelopmentPreview(projectId) {
  if (isLocalPlatform()) throw new Error('Verified preview is unsupported in local mode');
  await ensureDevelopmentWorkspace(projectId, { state: 'ready' });
  const commitHash = await workspaceCurrentCommit(projectId);
  if (!commitHash) throw new Error('Workspace commit unavailable');
  await processVerifyDevelopmentWorkspace(projectId, commitHash);
  return commitHash;
}

async function ensureWorkspace(projectId, options = {}) {
  let workspace = await loadWorkspace(projectId);
  const previewPort = Number(options.previewPort || workspace?.preview_port || WORKSPACE_SERVICE_PORT) || WORKSPACE_SERVICE_PORT;
  workspace = await ensureWorkspacePod(projectId, previewPort);
  if (options.cloneStarter) {
    await cloneStarterIntoWorkspace(projectId);
  } else if (options.hydrateFromStoredRepo) {
    await hydrateWorkspaceFromStoredRepo(projectId);
  }
  const commitSha = await workspaceCurrentCommit(projectId);
  const dirty = await workspaceIsDirty(projectId);
  workspace = await upsertWorkspace(projectId, {
    ...workspace,
    preview_port: previewPort,
    state: options.state || 'ready',
    current_commit_sha: commitSha || workspace?.current_commit_sha || null,
    workspace_dirty: dirty,
    idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS)
  });
  return workspace;
}

async function shouldRouteDevelopmentToVerified(projectId, commitHash) {
  const workspace = await loadWorkspace(projectId);
  if (!workspace) return true;
  if (!commitHash || workspace.current_commit_sha !== commitHash) return false;
  if (workspace.workspace_dirty) return false;
  if (await hasActiveTasks(projectId, 'development')) return false;
  return true;
}

async function restoreWorkspaceRouteIfNeeded(projectId) {
  if (isLocalPlatform()) return false;
  if (await isVerifiedOnlyDeploysEnabled()) return false;
  const workspace = await loadWorkspace(projectId);
  if (!workspace) return false;
  const envRes = await pool.query(
    'select build_status, deployed_commit from environments where project_id = $1 and name = $2',
    [projectId, 'development']
  );
  const envRow = envRes.rows[0] || null;
  if (envRow?.build_status === 'live') return false;
  const previewHealthy = await isWorkspacePreviewHealthy(
    projectId,
    Number(workspace.preview_port || WORKSPACE_SERVICE_PORT)
  );
  if (!previewHealthy) return false;
  await switchDevelopmentRoute(projectId, 'workspace');
  const liveCommit = await markDevelopmentPreviewLive(
    projectId,
    workspace.current_commit_sha || envRow?.deployed_commit || null
  );
  const liveTaskId =
    workspace.selected_commit_sha &&
    workspace.selected_commit_sha === (liveCommit || workspace.current_commit_sha || envRow?.deployed_commit || null)
      ? (workspace.selected_task_id || null)
      : null;
  await upsertWorkspace(projectId, {
    state: 'ready',
    preview_mode: 'workspace',
    live_task_id: liveTaskId,
    live_commit_sha: liveCommit || null,
    last_error: null,
    idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS)
  });
  emitProjectEvent(projectId, 'workspaceUpdated', {
    projectId,
    state: 'ready',
    preview_mode: 'workspace',
    commit_sha: liveCommit,
    live_task_id: liveTaskId,
    live_commit_sha: liveCommit
  });
  return true;
}

async function sleepWorkspace(projectId, options = {}) {
  const namespace = workspaceNamespace();
  const workspace = await loadWorkspace(projectId);
  if (!workspace) return;
  await stopWorkspacePreview(projectId);
  await deleteResource(namespace, 'pod', workspace.workspace_pod_name);
  await upsertWorkspace(projectId, {
    ...workspace,
    state: 'sleeping',
    live_task_id: null,
    live_commit_sha: null,
    idle_expires_at: null,
    last_error: null
  });
  if (options.routeToVerified && workspace.last_verified_commit_sha) {
    await switchDevelopmentRoute(projectId, 'verified');
  }
}

async function resetWorkspace(projectId) {
  const workspace = await ensureWorkspace(projectId, { hydrateFromStoredRepo: true, state: 'ready' });
  await stopWorkspacePreview(projectId);
  return workspace;
}

async function prepareDevelopmentWorkspaceForDeploy(projectId, commitHash = '') {
  let workspace = await ensureWorkspace(projectId, { state: 'ready' });
  let currentCommit = workspace?.current_commit_sha || (await workspaceCurrentCommit(projectId));
  let targetCommit = commitHash || currentCommit || '';
  let targetAvailable = targetCommit ? await workspaceHasCommit(projectId, targetCommit) : Boolean(currentCommit);

  if (!targetAvailable) {
    const hasStoredRepo = await projectHasStoredRepoSource(projectId);
    workspace = await ensureWorkspace(projectId, {
      hydrateFromStoredRepo: hasStoredRepo,
      cloneStarter: !hasStoredRepo,
      state: 'ready'
    });
    currentCommit = workspace?.current_commit_sha || (await workspaceCurrentCommit(projectId));
    targetCommit = commitHash || currentCommit || '';
    targetAvailable = targetCommit ? await workspaceHasCommit(projectId, targetCommit) : Boolean(currentCommit);
  }

  return {
    currentCommit: currentCommit || '',
    targetAvailable
  };
}

async function resumeDevelopmentFullBuildFromCache(projectId, commitHash, taskId, cacheMeta = {}) {
  const runtime = await getDevelopmentRuntimeContext(projectId);
  const { envPath, tempDir } = await writeEnvFile(runtime.envVars, runtime.dbUrl);
  try {
    const resumed = await resumeDeployment(projectId, 'development', envPath);
    if (!resumed) return false;
    const appName = `vibes-app-${projectId}`;
    const namespace = 'vibes-development';
    const internalHost = `${appName}.${namespace}.svc.cluster.local`;
    const host = hostFor(runtime.project, 'development');
    const appPort = Number(runtime.envVars.PORT || process.env.PORT || 3000);
    const healthHost = deploymentHealthHost('development', host, internalHost);
    const health = await waitForHealth(projectId, 'development', healthHost, appPort, null, {
      timeoutMs: healthTimeoutForHost(healthHost),
      internalHost
    });
    if (!health.ok) return false;
    await switchDevelopmentRoute(projectId, 'verified');
    await updateBuildStatus(projectId, 'development', 'live', commitHash || null);
    await upsertWorkspace(projectId, {
      state: 'ready',
      preview_mode: 'verified',
      last_verified_commit_sha: commitHash || null,
      selected_mode: 'verified',
      selected_task_id: taskId || null,
      selected_commit_sha: commitHash || null,
      live_task_id: taskId || null,
      live_commit_sha: commitHash || null,
      full_build_image_ref: cacheMeta.imageRef || null,
      full_build_commit_sha: commitHash || null,
      full_build_cache_key: cacheMeta.cacheKey || null,
      full_build_built_at: new Date(),
      last_error: null
    });
    emitProjectEvent(projectId, 'workspaceUpdated', {
      projectId,
      state: 'ready',
      preview_mode: 'verified',
      commit_sha: commitHash || null,
      verified_commit_sha: commitHash || null,
      live_task_id: taskId || null,
      live_commit_sha: commitHash || null
    });
    return true;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function activateDevelopmentSelection(projectId, overrides = {}) {
  const target = await resolveSelectedDevelopmentTarget(projectId, overrides);
  if (!target.commitHash) {
    throw new Error('No selected development commit is available');
  }
  await cancelSupersededDevelopmentWork(
    projectId,
    '\n\n[system] Cancel requested because the development environment is switching to a different task or mode.\n'
  );
  await stopEnvironment(projectId, 'development');
  await upsertWorkspace(projectId, {
    state: 'starting',
    selected_mode: target.mode,
    selected_task_id: target.taskId || null,
    selected_commit_sha: target.commitHash,
    live_task_id: null,
    live_commit_sha: null,
    last_error: null
  });
  emitProjectEvent(projectId, 'workspaceUpdated', {
    projectId,
    state: 'starting',
    preview_mode: target.mode,
    commit_sha: null,
    verified_commit_sha: null,
    live_task_id: null,
    live_commit_sha: null
  });

  if (target.mode === 'workspace') {
    await ensureDevelopmentWorkspace(projectId, { state: 'ready' });
    await checkoutWorkspaceCommit(projectId, target.commitHash);
    const preview = await startWorkspacePreview(projectId, {
      forceRestart: true,
      failurePreviewMode: 'workspace'
    });
    if (!preview.started) {
      throw new Error('Preview command not detected for workspace');
    }
    await switchDevelopmentRoute(projectId, 'workspace');
    const liveCommit = await markDevelopmentPreviewLive(projectId, preview.commitSha || target.commitHash);
    await upsertWorkspace(projectId, {
      state: 'ready',
      preview_mode: 'workspace',
      current_commit_sha: liveCommit || target.commitHash,
      workspace_dirty: false,
      selected_mode: 'workspace',
      selected_task_id: target.taskId || null,
      selected_commit_sha: target.commitHash,
      live_task_id: target.taskId || null,
      live_commit_sha: liveCommit || target.commitHash,
      idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS),
      last_error: null
    });
    emitProjectEvent(projectId, 'workspaceUpdated', {
      projectId,
      state: 'ready',
      preview_mode: 'workspace',
      commit_sha: liveCommit || target.commitHash,
      verified_commit_sha: null,
      live_task_id: target.taskId || null,
      live_commit_sha: liveCommit || target.commitHash
    });
    return {
      mode: 'workspace',
      commitHash: liveCommit || target.commitHash,
      taskId: target.taskId || null,
      reused: false
    };
  }

  const cacheMeta = await computeDevelopmentFullBuildCacheMeta(projectId, target.commitHash);
  const workspace = await loadWorkspace(projectId);
  const canReuse =
    workspace?.full_build_commit_sha === target.commitHash &&
    workspace?.full_build_cache_key &&
    cacheMeta.cacheKey &&
    workspace.full_build_cache_key === cacheMeta.cacheKey;
  if (canReuse) {
    const reused = await resumeDevelopmentFullBuildFromCache(
      projectId,
      target.commitHash,
      target.taskId || null,
      {
        ...cacheMeta,
        imageRef: workspace?.full_build_image_ref || cacheMeta.imageRef || ''
      }
    );
    if (reused) {
      return {
        mode: 'verified',
        commitHash: target.commitHash,
        taskId: target.taskId || null,
        reused: true
      };
    }
  }

  await processVerifyDevelopmentWorkspace(projectId, target.commitHash, {
    activateOnSuccess: true,
    taskId: target.taskId || null,
    cacheMeta
  });
  return {
    mode: 'verified',
    commitHash: target.commitHash,
    taskId: target.taskId || null,
    reused: false
  };
}

async function cleanupWorkspace(projectId, { deletePvc = false } = {}) {
  if (isLocalPlatform()) {
    await fs.rm(localProjectRepoPath(projectId), { recursive: true, force: true });
    await pool.query(
      'delete from project_workspaces where project_id = $1 and environment = $2',
      [projectId, 'development']
    );
    return;
  }
  const namespace = workspaceNamespace();
  const workspace = await loadWorkspace(projectId);
  const names = workspaceNames(projectId);
  const podName = workspace?.workspace_pod_name || names.podName;
  const serviceName = workspace?.service_name || names.serviceName;
  const pvcName = workspace?.pvc_name || names.pvcName;
  await stopWorkspacePreview(projectId);
  await deleteResource(namespace, 'service', serviceName);
  await deleteResource(namespace, 'pod', podName);
  if (deletePvc) {
    await deleteResource(namespace, 'pvc', pvcName);
  }
  if (WORKSPACE_SNAPSHOT_BUCKET) {
    try {
      const prefix = String(WORKSPACE_SNAPSHOT_PREFIX || 'project-workspaces').replace(/^\/+|\/+$/g, '');
      await exec('aws', ['s3', 'rm', `s3://${WORKSPACE_SNAPSHOT_BUCKET}/${prefix}/${projectId}/`, '--recursive']);
    } catch (err) {
      console.warn(`Failed to remove workspace checkpoints for ${projectId}`, err?.message || err);
    }
  }
  await pool.query(
    'delete from project_workspaces where project_id = $1 and environment = $2',
    [projectId, 'development']
  );
}

async function deployEnvironment(projectId, environment, commitHash, buildId = null, options = {}) {
  console.log(`Deploying project ${projectId} environment ${environment}...`);
  const command = deployCommandForEnv(environment);
  if (!command) return;
  const settingsRes = await pool.query(
    `select key, value from settings
     where key in (
       'healthcheck_path',
       'healthcheck_path_dev',
       'healthcheck_path_test',
       'healthcheck_path_prod',
       'healthcheck_protocol',
       'healthcheck_protocol_dev',
       'healthcheck_protocol_test',
       'healthcheck_protocol_prod',
       'healthcheck_timeout_ms',
       'healthcheck_interval_ms'
     )`
  );
  const settings = {};
  for (const row of settingsRes.rows) settings[row.key] = row.value;
  if (settings.healthcheck_path) HEALTHCHECK_DEFAULTS.path = settings.healthcheck_path;
  if (settings.healthcheck_path_dev) HEALTHCHECK_DEFAULTS.pathDev = settings.healthcheck_path_dev;
  if (settings.healthcheck_path_test) HEALTHCHECK_DEFAULTS.pathTest = settings.healthcheck_path_test;
  if (settings.healthcheck_path_prod) HEALTHCHECK_DEFAULTS.pathProd = settings.healthcheck_path_prod;
  if (settings.healthcheck_protocol) HEALTHCHECK_DEFAULTS.protocol = settings.healthcheck_protocol;
  if (settings.healthcheck_protocol_dev) HEALTHCHECK_DEFAULTS.protocolDev = settings.healthcheck_protocol_dev;
  if (settings.healthcheck_protocol_test) HEALTHCHECK_DEFAULTS.protocolTest = settings.healthcheck_protocol_test;
  if (settings.healthcheck_protocol_prod) HEALTHCHECK_DEFAULTS.protocolProd = settings.healthcheck_protocol_prod;
  if (settings.healthcheck_timeout_ms) HEALTHCHECK_DEFAULTS.timeoutMs = Number(settings.healthcheck_timeout_ms);
  if (settings.healthcheck_interval_ms) HEALTHCHECK_DEFAULTS.intervalMs = Number(settings.healthcheck_interval_ms);
  const envRes = await pool.query(
    'select env_vars, db_url, db_name from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  const projectRes = await pool.query(
    'select name, short_id, project_slug from projects where id = $1',
    [projectId]
  );
  const project = projectRes.rows[0];
  const host = hostFor(project, environment);
  const envVars = envRes.rows[0]?.env_vars || {};
  let dbUrl = envRes.rows[0]?.db_url || null;
  if (!project?.short_id) throw new Error('Project not found');
  const dbName = envRes.rows[0]?.db_name || dbNameFor(project.short_id, environment);
  const needsRecompute = !dbUrl || !dbUrlMatchesConfig(dbUrl);
  if (needsRecompute) {
    await ensureDatabase(dbName);
    dbUrl = dbUrlFor(dbName);
    await pool.query(
      `insert into environments (project_id, name, db_name, db_url)
       values ($1, $2, $3, $4)
       on conflict (project_id, name)
       do update set db_name = excluded.db_name, db_url = excluded.db_url`,
      [projectId, environment, dbName, dbUrl]
    );
  }
  const { envPath, tempDir: envTemp } = await writeEnvFile(envVars, dbUrl);
  try {
    await fs.access(envPath);
    console.log(`Env file ready at ${envPath}`);
  } catch (err) {
    throw new Error(`Env file missing before deploy: ${envPath} (${err?.message || err})`);
  }
  const appName = `vibes-app-${projectId}`;
  const namespace = `vibes-${environment}`;
  const internalHost = `${appName}.${namespace}.svc.cluster.local`;
  const healthHost = deploymentHealthHost(environment, host, internalHost);
  const healthTimeoutMs = healthTimeoutForHost(healthHost);
  let repoTemp = null;
  let archiveDir = null;
  let snapshotPath = '';
  const hasWorkspace = !isLocalPlatform() && Boolean(await loadWorkspace(projectId));
  const canUseWorkspaceSource =
    !isLocalPlatform() &&
    Boolean(commitHash) &&
    (options.source === 'workspace' || (options.source !== 'snapshot' && hasWorkspace));
  if (canUseWorkspaceSource) {
    try {
      const exported = await exportWorkspaceSnapshot(projectId, commitHash || '');
      snapshotPath = exported.snapshotPath;
      archiveDir = exported.tempDir;
      commitHash = exported.commitHash;
    } catch (err) {
      if (options.source === 'workspace') {
        throw err;
      }
      console.warn(`Workspace export failed for ${projectId}/${environment}; falling back to repo bundle`, err?.message || err);
    }
  }
  if (!snapshotPath) {
    if (isLocalPlatform() && await localProjectRepoExists(projectId)) {
      const loaded = await cloneRepoToTemp(localProjectRepoPath(projectId));
      const repoPath = loaded.repoPath;
      repoTemp = loaded.tempDir;
      if (commitHash) {
        try {
          await runGit(['checkout', commitHash], repoPath);
        } catch (err) {
          throw new Error(`Commit ${commitHash} is unavailable for full build`);
        }
      }
      const archived = await createSnapshotArchive(repoPath, 'deploy-snapshot');
      snapshotPath = archived.archivePath;
      archiveDir = archived.archiveDir;
    } else {
      const loaded = await loadRepoFromStoredSource(projectId);
      const repoPath = loaded.repoPath;
      repoTemp = loaded.tempDir;
      if (commitHash) {
        try {
          await runGit(['checkout', commitHash], repoPath);
        } catch (err) {
          throw new Error(`Commit ${commitHash} is unavailable for full build`);
        }
      }
      const archived = await createSnapshotArchive(repoPath, 'deploy-snapshot');
      snapshotPath = archived.archivePath;
      archiveDir = archived.archiveDir;
    }
  }
  let snapshotHash = '';
  let deployTag = commitHash || '';
  if (!deployTag) {
    snapshotHash = (await hashFile(snapshotPath)).slice(0, 12);
    deployTag = snapshotHash;
  }
  if (buildId) {
    const suffix = String(buildId).replace(/[^a-zA-Z0-9]+/g, '').slice(0, 12);
    if (suffix) deployTag = `${deployTag}-${suffix}`;
  }
  const env = {
    ...process.env,
    PROJECT_ID: projectId,
    PROJECT_SHORT_ID: project?.short_id || '',
    ENVIRONMENT: environment,
    COMMIT_HASH: commitHash || '',
    DEPLOY_TAG: deployTag,
    APP_NAME: appName,
    NAMESPACE: namespace,
    ENV_FILE: envPath,
    SNAPSHOT_PATH: snapshotPath,
    APP_HOST: host,
    DATABASE_URL: dbUrl || '',
    SKIP_INGRESS: options.skipIngress ? 'true' : 'false',
    ...(PLATFORM_ENV === 'local' && LOCAL_LAN_IP ? { APP_LAN_IP: LOCAL_LAN_IP } : {})
  };
  let output = '';
  try {
    console.log(`Deploy command: ${command}`);
    console.log('Deploy env:', {
      PROJECT_ID: env.PROJECT_ID,
      ENVIRONMENT: env.ENVIRONMENT,
      COMMIT_HASH: env.COMMIT_HASH,
      APP_NAME: env.APP_NAME,
      NAMESPACE: env.NAMESPACE,
      ENV_FILE: env.ENV_FILE,
      SNAPSHOT_PATH: env.SNAPSHOT_PATH,
      DEPLOY_TAG: env.DEPLOY_TAG,
      APP_HOST: env.APP_HOST,
      AWS_REGION: env.AWS_REGION,
      AWS_ACCOUNT_ID: env.AWS_ACCOUNT_ID,
      ECR_REPO: env.ECR_REPO,
      ACM_CERT_ARN: env.ACM_CERT_ARN,
      DOMAIN: env.DOMAIN
    });
    const probePaths = ['/usr/bin/aws', '/usr/bin/python3', '/usr/bin/node', '/bin/sh', '/bin/ls'];
    const probeResults = {};
    for (const probePath of probePaths) {
      try {
        await fs.access(probePath);
        probeResults[probePath] = 'present';
      } catch {
        probeResults[probePath] = 'missing';
      }
    }
    console.log('Runtime path probe:', {
      cwd: process.cwd(),
      path: process.env.PATH,
      probes: probeResults
    });
    try {
      await ensureBuildNotCancelled(buildId);
      const { stdout, stderr } = await runCommandStreaming(command, env, { buildId });
      output = `${stdout || ''}${stderr || ''}`;
    } catch (err) {
      const errStdout = err?.stdout || '';
      const errStderr = err?.stderr || '';
      const errMsg = err?.message || String(err);
      console.error(`Deploy exec failed: ${errMsg}`);
      if (errStdout) console.log(`Deploy stdout (error):\n${errStdout}`);
      if (errStderr) console.warn(`Deploy stderr (error):\n${errStderr}`);
      output = `${errStdout}${errStderr}`.trim();
      throw err;
    }
  } finally {
    await fs.rm(archiveDir, { recursive: true, force: true });
    await fs.rm(envTemp, { recursive: true, force: true });
    if (repoTemp) {
      await fs.rm(repoTemp, { recursive: true, force: true });
    }
  }
  const appPort = Number(envVars.PORT || process.env.PORT || 3000);
  if (buildId) {
    await appendBuildLog(
      buildId,
      `\n[system] Waiting for health check on ${healthcheckUrl(environment, healthHost)} (timeout ${healthTimeoutMs}ms)\n`
    );
  }
  const health = await waitForHealth(projectId, environment, healthHost, appPort, buildId, {
    timeoutMs: healthTimeoutMs,
    internalHost
  });
  if (!health.ok) {
    if (health.fastFail) {
      const baseDetail = [
        formatFailureClassification(health.fastFail.classification || null),
        health.fastFail.message,
        health.fastFail.detail
      ]
        .filter(Boolean)
        .join('\n');
      const err = new Error(`Deploy failed early: ${health.fastFail.reason || 'pod_error'}`);
      err.code = 'deploy_failed_fast';
      err.detail = baseDetail;
      err.classification = health.fastFail.classification || null;
      err.host = host;
      throw err;
    }
    const err = await buildHealthcheckError(projectId, environment, host);
    if (health.crashloop) {
      const detail = `CrashLoopBackOff detected (${health.crashloop.restartCount} restarts) on pod ${health.crashloop.podName || 'unknown'}.`;
      err.detail = `${detail}\n\n${err.detail || ''}`.trim();
    }
    throw err;
  }
  return output;
}

async function cleanupDevRuntime(projectId, shortId, environment) {
  const confDir = path.join(VIBES_WORKDIR_ROOT, 'nginx', 'conf.d');
  const workdir = path.join(VIBES_WORKDIR_ROOT, `deploy-${projectId}-${environment}`);
  await fs.rm(path.join(confDir, `${projectId}-${environment}.conf`), { force: true });
  await fs.rm(path.join(confDir, `${shortId}-${environment}.conf`), { force: true });
  await fs.rm(workdir, { recursive: true, force: true });
  const container = `vibes-app-${projectId}-${environment}`;
  await exec('sh', ['-lc', `podman rm -f ${container} >/dev/null 2>&1 || true`]);
  await exec('sh', ['-lc', 'podman exec vibes-nginx nginx -s reload >/dev/null 2>&1 || true']);
}

function cleanupErrorDetails(err) {
  const message = err?.message || String(err || 'cleanup failed');
  const stdout = err?.stdout ? String(err.stdout) : '';
  const stderr = err?.stderr ? String(err.stderr) : '';
  const commandOutput = [stdout, stderr, message].filter(Boolean).join('\n').trim();
  return {
    message: truncateText(message, 1000),
    stdout: truncateText(stdout, 3500),
    stderr: truncateText(stderr, 3500),
    command_output: truncateText(commandOutput, 7000)
  };
}

function cleanupResourceTypesFromCommandFailure(err, options = {}) {
  const text = `${err?.message || ''}\n${err?.stdout || ''}\n${err?.stderr || ''}`.toLowerCase();
  const resourceTypes = new Set();
  if (/(kubectl|ingress|deployment|service|secret|namespace|pod\b)/.test(text)) resourceTypes.add('k8s');
  if (/(route53|dns|hosted zone|record set|auto_dns)/.test(text)) resourceTypes.add('dns');
  if (/(ecr|batch-delete-image|list-images|repository-name|imageids|image ids)/.test(text)) resourceTypes.add('ecr');
  if (resourceTypes.size === 0) {
    resourceTypes.add('k8s');
    if (options.autoDnsEnabled) resourceTypes.add('dns');
    if (options.deleteEcrEnabled) resourceTypes.add('ecr');
  }
  return Array.from(resourceTypes);
}

async function processDeleteProject(projectId) {
  const projectRes = await pool.query(
    'select id, owner_id, name, short_id, project_slug from projects where id = $1',
    [projectId]
  );
  if (projectRes.rowCount === 0) return;
  const project = projectRes.rows[0];
  const envRes = await pool.query(
    'select name, db_name from environments where project_id = $1',
    [projectId]
  );
  const envs = envRes.rows.length
    ? envRes.rows
    : ['development', 'testing', 'production'].map((name) => ({ name, db_name: null }));
  const envContexts = envs.map((env) => ({
    name: env.name,
    db_name: env.db_name || dbNameFor(project.short_id, env.name),
    host: hostFor(project, env.name),
    delete_command: deleteCommandForEnv(env.name)
  }));
  const cleanupFailures = [];
  const autoDnsEnabled = Boolean(process.env.AUTO_DNS) && String(process.env.AUTO_DNS).toLowerCase() !== 'false';
  const deleteEcrEnabled = String(process.env.DELETE_ECR_IMAGES || 'true').toLowerCase() !== 'false';

  try {
    await cleanupWorkspace(projectId, { deletePvc: true });
  } catch (err) {
    cleanupFailures.push({
      environment: 'development',
      host: hostFor(project, 'development'),
      db_name: dbNameFor(project.short_id, 'development'),
      resource_types: ['k8s', 'storage'],
      operation: 'cleanup_workspace',
      ...cleanupErrorDetails(err)
    });
  }

  for (const env of envContexts) {
    try {
      await dropDatabase(env.db_name);
    } catch (err) {
      cleanupFailures.push({
        environment: env.name,
        host: env.host,
        db_name: env.db_name,
        resource_types: ['db'],
        operation: 'drop_database',
        ...cleanupErrorDetails(err)
      });
    }
    const cmd = env.delete_command;
    if (cmd) {
      const envVars = {
        ...process.env,
        PROJECT_ID: projectId,
        PROJECT_SHORT_ID: project.short_id,
        ENVIRONMENT: env.name,
        APP_HOST: env.host
      };
      try {
        await exec('sh', ['-lc', cmd], { env: envVars });
      } catch (err) {
        cleanupFailures.push({
          environment: env.name,
          host: env.host,
          db_name: env.db_name,
          resource_types: cleanupResourceTypesFromCommandFailure(err, { autoDnsEnabled, deleteEcrEnabled }),
          operation: 'delete_command',
          command: cmd,
          ...cleanupErrorDetails(err)
        });
      }
    } else if (env.name === 'development') {
      try {
        await cleanupDevRuntime(projectId, project.short_id, env.name);
      } catch (err) {
        cleanupFailures.push({
          environment: env.name,
          host: env.host,
          db_name: env.db_name,
          resource_types: ['k8s'],
          operation: 'cleanup_dev_runtime',
          ...cleanupErrorDetails(err)
        });
      }
    } else {
      cleanupFailures.push({
        environment: env.name,
        host: env.host,
        db_name: env.db_name,
        resource_types: ['k8s', 'dns', 'ecr'],
        operation: 'delete_command',
        command: null,
        message: 'Delete command not configured for environment',
        stdout: '',
        stderr: '',
        command_output: 'Delete command not configured for environment'
      });
    }
  }
  await pool.query('delete from projects where id = $1', [projectId]);
  emitProjectEvent(projectId, 'projectDeleted', { projectId });
  if (cleanupFailures.length) {
    const summary = cleanupFailures
      .map((failure) => {
        const types = Array.isArray(failure.resource_types) ? failure.resource_types.join(', ') : 'unknown';
        return `env ${failure.environment} [${types}] ${failure.message || 'cleanup failed'}`;
      })
      .join('\n');
    const payload = {
      project_id: project.id,
      owner_id: project.owner_id,
      name: project.name,
      slug: project.project_slug || hostProjectName(project.name),
      short_id: project.short_id,
      environments: envContexts.map((env) => ({
        name: env.name,
        host: env.host,
        db_name: env.db_name,
        delete_command: env.delete_command || null
      })),
      cleanup_failure_count: cleanupFailures.length,
      cleanup_failures: cleanupFailures,
      summary: truncateText(summary, 3500),
      project_row_deleted: true
    };
    const message = `Delete project ${projectId} completed with cleanup failures`;
    console.warn(message);
    console.warn(JSON.stringify(payload, null, 2));
    try {
      await sendAlert('project_delete_cleanup_failed', message, payload, `project:${projectId}`);
    } catch (err) {
      console.warn('Failed to emit project delete cleanup alert', err?.message || err);
    }
  }
}

const socket = socketIoClient(SOCKET_URL, {
  transports: ['websocket'],
  reconnection: true
});

function emitProjectEvent(projectId, event, payload) {
  if (!projectId) return;
  socket.emit('projectEvent', { projectId, event, payload });
}

async function runGit(args, cwd) {
  await exec('git', args, { cwd });
}

async function gitOutput(args, cwd) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function ensureRepo(repoPath) {
  try {
    await fs.access(path.join(repoPath, '.git'));
    return;
  } catch {
    await runGit(['init'], repoPath);
    await runGit(['config', 'user.name', AUTHOR_NAME], repoPath);
    await runGit(['config', 'user.email', AUTHOR_EMAIL], repoPath);
    await runGit(['add', '.'], repoPath);
    await runGit(['commit', '-m', 'init'], repoPath);
  }
}

async function loadRepoFromBundleBuffer(buffer) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-'));
  const bundlePath = path.join(tempDir, 'repo.bundle');
  const repoPath = path.join(tempDir, 'repo');
  await fs.writeFile(bundlePath, buffer);
  await exec('git', ['clone', bundlePath, repoPath]);
  await fs.rm(bundlePath, { force: true });
  try {
    await exec('sh', ['-lc', `chmod -R u+rwX "${repoPath}"`]);
  } catch { }
  await ensureRepo(repoPath);
  return { repoPath, tempDir };
}

async function loadRepoFromLegacySnapshotBuffer(buffer) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-'));
  const snapshotPath = path.join(tempDir, 'snapshot.tar.gz');
  await fs.writeFile(snapshotPath, buffer);
  await tar.x({ file: snapshotPath, cwd: tempDir, gzip: true });
  await fs.rm(snapshotPath, { force: true });
  const repoPath = await detectRepoRoot(tempDir);
  await stripSnapshotArtifacts(repoPath);
  try {
    await exec('sh', ['-lc', `chmod -R u+rwX "${repoPath}"`]);
  } catch { }
  await ensureRepo(repoPath);
  return { repoPath, tempDir };
}

async function loadRepoFromStoredSource(projectId) {
  const source = await loadStoredProjectSource(projectId);
  if (source?.repo_bundle_blob) {
    return loadRepoFromBundleBuffer(source.repo_bundle_blob);
  }
  if (source?.snapshot_blob) {
    return loadRepoFromLegacySnapshotBuffer(source.snapshot_blob);
  }
  throw new Error('Project repository missing');
}

async function createRepoBundle(repoPath, namePrefix = 'repo') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-repo-bundle-'));
  const bundlePath = path.join(tempDir, `${namePrefix}.bundle`);
  await runGit(['bundle', 'create', bundlePath, '--all'], repoPath);
  return { bundlePath, tempDir };
}

async function cloneRepoToTemp(sourceRepoPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-repo-clone-'));
  const repoPath = path.join(tempDir, 'repo');
  await exec('git', ['clone', sourceRepoPath, repoPath]);
  return { repoPath, tempDir };
}

async function persistRepoBundleBlob(projectId, bundlePath) {
  const bundle = await fs.readFile(bundlePath);
  await pool.query(
    `update projects
        set repo_bundle_blob = $1,
            repo_bundle_updated_at = now(),
            snapshot_blob = null,
            snapshot_status = $2
      where id = $3`,
    [bundle, 'ready', projectId]
  );
}

async function syncRepoBundleFromRepoPath(projectId, repoPath, namePrefix = 'repo') {
  const bundled = await createRepoBundle(repoPath, namePrefix);
  try {
    await persistRepoBundleBlob(projectId, bundled.bundlePath);
  } finally {
    await fs.rm(bundled.tempDir, { recursive: true, force: true });
  }
}

async function ensureLocalProjectRepo(projectId, options = {}) {
  const repoPath = localProjectRepoPath(projectId);
  const repoExists = await localProjectRepoExists(projectId);
  if (repoExists && !options.forceHydrate) return { repoPath };

  await fs.mkdir(LOCAL_PROJECT_REPO_ROOT, { recursive: true });
  await fs.rm(repoPath, { recursive: true, force: true });

  if (options.cloneStarter) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-local-starter-'));
    const tempRepo = path.join(tempDir, 'repo');
    try {
      await cloneStarterRepo(tempRepo);
      await fs.cp(tempRepo, repoPath, { recursive: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } else if (options.hydrateFromStoredRepo) {
    const loaded = await loadRepoFromStoredSource(projectId);
    try {
      await fs.cp(loaded.repoPath, repoPath, { recursive: true });
    } finally {
      await fs.rm(loaded.tempDir, { recursive: true, force: true });
    }
  } else if (!repoExists) {
    throw new Error('Project repository missing');
  }

  await ensureRepo(repoPath);
  return { repoPath };
}

async function cloneStarterRepo(destDir) {
  if (!STARTER_REPO_URL) throw new Error('STARTER_REPO_URL not set');
  let repoUrl = STARTER_REPO_URL;
  if (GIT_TOKEN && repoUrl.startsWith('https://')) {
    const prefix = 'https://';
    repoUrl = `${prefix}${GIT_TOKEN}@${repoUrl.slice(prefix.length)}`;
  }
  await exec('git', ['clone', '--depth', '1', '--branch', STARTER_REPO_REF, repoUrl, destDir]);
  await runGit(['config', 'user.name', AUTHOR_NAME], destDir);
  await runGit(['config', 'user.email', AUTHOR_EMAIL], destDir);
}

async function detectRepoRoot(extractDir) {
  try {
    await fs.access(path.join(extractDir, '.git'));
    return extractDir;
  } catch {
    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 1) {
      const candidate = path.join(extractDir, dirs[0]);
      try {
        await fs.access(path.join(candidate, '.git'));
        return candidate;
      } catch {
        return candidate;
      }
    }
  }
  return extractDir;
}

// {"type":"thread.started","thread_id":"019c96a1-43f8-7fb1-958d-16dadbf76247"} 
// {"type":"turn.started"} 
// {"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}} 
// {"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"package-lock.json\npackage.json\npublic\nserver.js\nsnapshot-updated.tar.gz\nsnapshot.tar.gz\nviews\n","exit_code":0,"status":"completed"}}

function sanitizeCodexSummary(raw) {
   if (!raw) {
    return '';
  }
  let lastItemNumber = -1;
  return raw
    .split("\n")
    .filter(line => line.trim() !== "").map(JSON.parse).map(obj => {
      if (!obj.item) {
        return '';
      }
      if(obj.item.type == 'agent_message'){
         return `${obj.item.text}`;
      }
      /*
      const stepNumber = obj.item.id.split("_")[1];
      if (stepNumber !== lastItemNumber) {
            lastItemNumber++;
        return '';
      }
      let filesChanged = '';
      if(obj.item.type =='file_change'){
        const files = obj.item.changes.map(change => {
          return change.path.split('/T/').split('/').slice(1).join('/');
        })
        filesChanged = `File changes: ${files.join(', ')}`;
      }
      if(obj.item.type == 'agent_message'){
        filesChanged = `Agent message: ${obj.item.text}`;
      }
      const statement = `${stepNumber}) ${obj.item.type?.split('.').join(' ')}: ${filesChanged? filesChanged : ''}${obj.item.command ? obj.item.command?.split('_').join(' ') : ''}
      ${obj.item.exit_code ? `exit code: ${obj.item.exit_code}` : ''}  ${`status: ${obj.item.status}`}`;
      console.log(statement);
      return statement*/

    }).filter(i => i).join("\n");

 


}

function extractCodexThreadId(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === 'thread.started' && obj.thread_id) return obj.thread_id;
      if (obj?.thread_id && typeof obj.thread_id === 'string') return obj.thread_id;
    } catch {}
  }
  return '';
}

function codexWrapperMode() {
  const mode = String(process.env.CODEX_WRAPPER_MODE || 'lean').trim().toLowerCase();
  return mode === 'strict' ? 'strict' : 'lean';
}

function buildCodexPrompt(prompt, mode = codexWrapperMode()) {
  const strictWrapper = [
    'You are modifying this repository directly.',
    'Current branch: ai-task (do not change this).',
    '',
    'TASK:',
    prompt,
    '',
    'MISSION:',
    'Ship working code now. Prioritize reliability and user-visible progress over perfect completeness.',
    '',
    'HARD REQUIREMENTS (cannot be violated):',
    '1) The app must remain deployable and startable after changes.',
    '2) If uncertain, choose the safest working implementation and continue.',
    '3) Do not leave partially broken code paths.',
    '4) Do not output only advice; make concrete code changes.',
    '',
    'PLATFORM CONTRACT:',
    '- Runtime is always live-server/containerized (not local-dev assumptions).',
    '- Dockerfile present => Dockerfile is source of truth.',
    '- No Dockerfile => fallback assumptions:',
    '  - Node runtime',
    '  - START_COMMAND if provided; otherwise npm start',
    '- App must bind 0.0.0.0:$PORT (default 3000 if unset).',
    '- Health check endpoint is fixed at `/` (root path) and must return success (2xx/3xx).',
    '- Do not assume custom health check paths unless explicitly provided by platform in the future.',
    '- Do not run dependency install or build/compile steps during runtime startup; startup should only launch the app.',
    '- DATABASE_URL is PostgreSQL.',
    '- If Prisma is used in development: RUN_MIGRATIONS=true must be startup-idempotent.',
    '- In development, do not crash startup on Prisma P3005 (non-empty schema); warn and continue or use a safe fallback.',
    '',
    'STACK-AGNOSTIC BEHAVIOR:',
    '- Preserve existing stack unless user explicitly asks to change it.',
    '- Non-Node apps are valid when Dockerfile defines runtime.',
    '- Never force framework migrations unless required.',
    '',
    'NON-TECHNICAL CUSTOMER DEFAULT:',
    '- Infer intent from outcomes, not technical wording.',
    '- Deliver visible product progress each task.',
    '- If request is broad, ship highest-value vertical slice that runs.',
    '',
    'STRICT UX LANGUAGE POLICY:',
    '- Never expose internal IDs, slugs, UUIDs, commit hashes, table names, env var names, or infra terms in customer-facing UI.',
    '- Never use implementation technology names as user-facing labels.',
    '- Use plain-language copy for end users.',
    '- Technical details belong in logs/admin/debug only.',
    '',
    'IMPLEMENTATION PROTOCOL (follow in order):',
    'A) Read current code paths affected by the task.',
    'B) Implement end-to-end changes (UI/API/data/config) needed for one working slice.',
    'C) Run available validation/startup checks.',
    'D) Fix issues found before finalizing.',
    'E) Ensure at least one user-visible improvement is working.',
    '',
    'QUALITY GATE (must pass before final response):',
    '- Startup reliability preserved.',
    '- Primary changed flow works.',
    '- UX leak check passed (no technical/internal wording in customer UI).',
    '- Any required env vars/config documented clearly.',
    '',
    'RESPONSE FORMAT (plain text, no markdown fences):',
    '1) Progress made toward customer goal',
    '2) What now works',
    '3) Required config/env (if any)',
    '4) Remaining gaps/tradeoffs',
    '5) Verification performed',
    '6) Startup status: PASS or FAIL'
  ].join('\n');

  if (mode === 'strict') return strictWrapper;

  return [
    'You are modifying this repository directly.',
    'Current branch: ai-task (do not change this).',
    '',
    'TASK:',
    prompt,
    '',
    'MISSION:',
    'Implement the request with concrete code changes that run in this repo.',
    '',
    'PRIORITIES:',
    '- Prefer minimal, reliable edits that preserve existing architecture.',
    '- Keep deploy/startup healthy.',
    '- If uncertain, choose the safest working implementation and continue.',
    '- Make tangible user-visible progress.',
    '',
    'PLATFORM GUARDRAILS:',
    '- Container/live-server runtime assumptions.',
    '- Bind 0.0.0.0:$PORT (default 3000).',
    '- Health endpoint `/` must return 2xx/3xx.',
    '- Do not run dependency install or build/compile steps during runtime startup; startup should only launch the app.',
    '- Use DATABASE_URL for Postgres when needed.',
    '- If Prisma is present in development and RUN_MIGRATIONS is not false, migration startup must be idempotent.',
    '- Do not crash startup on Prisma P3005 in development; handle it as a warning/fallback.',
    '',
    'EXECUTION:',
    '1) Read affected files first.',
    '2) Implement an end-to-end working slice.',
    '3) Run available checks and fix issues.',
    '',
    'RESPONSE FORMAT (plain text):',
    '1) What changed',
    '2) What now works',
    '3) Required config/env',
    '4) Remaining gaps',
    '5) Verification performed'
  ].join('\n');
}

async function runCodex(prompt, cwd, threadId = '', apiKey = '') {
  const trimmedKey = (apiKey || '').trim();
  await ensureCodexAuth();
  const wrapperMode = codexWrapperMode();
  const wrappedPrompt = buildCodexPrompt(prompt, wrapperMode);
  const responseFilePath = path.join(cwd, '.codex-last-message.txt');
  const template = process.env.CODEX_COMMAND_TEMPLATE;
  const resumeTemplate = process.env.CODEX_COMMAND_TEMPLATE_RESUME;
  console.log('Codex config:', {
    wrapperMode,
    hasTemplate: Boolean(template),
    hasResumeTemplate: Boolean(resumeTemplate),
    codexCommand: process.env.CODEX_COMMAND || '',
    codexArgs: process.env.CODEX_ARGS || ''
  });
  if (template) {
    const env = {
      ...process.env,
      ...(trimmedKey ? { OPENAI_API_KEY: trimmedKey } : {}),
      CODEX_PROMPT: wrappedPrompt,
      CODEX_RESPONSE_FILE: responseFilePath,
      CODEX_THREAD_ID: threadId
    };

    try {
      const commandTemplate = threadId && resumeTemplate ? resumeTemplate : template;

      const { stdout, stderr } = await exec('sh', ['-lc', commandTemplate], { cwd, env });
      const stdoutText = stdout || '';
      let summaryRaw = stdoutText;
      const summary = sanitizeCodexSummary(summaryRaw);
      console.log('Codex stdout:', summary);
      return {
        output: `${summary}${stderr}`,
        threadId: extractCodexThreadId(stdoutText || summaryRaw)
      };
    } catch (error) {
      // exec throws if exit code is non-zero; handle error.stdout/stderr here
      const errStdout = error?.stdout || '';
      const errStderr = error?.stderr || '';
      const errMessage = error?.message || '';
      console.log('Codex error stderr:', errStderr || errMessage);
      return { output: `${errStdout}${errStderr || errMessage}`, threadId: '' };
    }
  }
  console.log('Running Codex with command/args...');
  const command = process.env.CODEX_COMMAND || 'codex';
  const args = (process.env.CODEX_ARGS || '').split(' ').filter(Boolean);
  const promptFlag = process.env.CODEX_PROMPT_FLAG || '--prompt';
  const resumeSubcommand = process.env.CODEX_RESUME_SUBCOMMAND || 'resume';
  const execArgs = threadId
    ? [resumeSubcommand, threadId, ...args, promptFlag, wrappedPrompt]
    : [...args, promptFlag, wrappedPrompt];
  const env = trimmedKey ? { ...process.env, OPENAI_API_KEY: trimmedKey } : undefined;
  const { stdout, stderr } = await exec(command, execArgs, { cwd, env });
  return { output: `${stdout || ''}${stderr || ''}`, threadId: extractCodexThreadId(stdout || '') };
}

async function ensureCodexAuth() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  const authPath = path.join(process.env.HOME || '/root', '.codex', 'auth.json');
  try {
    await fs.access(authPath);
    return;
  } catch {}
  try {
    // Avoid logging the API key; feed it via stdin.
    await exec('sh', ['-lc', 'printenv OPENAI_API_KEY | codex login --with-api-key']);
  } catch (error) {
    const errStderr = error?.stderr || '';
    const errMessage = error?.message || '';
    console.log('Codex login failed:', errStderr || errMessage);
  }
}

async function runCodexInWorkspace(prompt, projectId, threadId = '', apiKey = '') {
  await ensureWorkspace(projectId);
  const namespace = workspaceNamespace();
  const workspace = (await loadWorkspace(projectId)) || workspaceNames(projectId);
  const podName = workspace.workspace_pod_name || workspaceNames(projectId).podName;
  const trimmedKey = String(apiKey || '').trim();
  const forwardedEnv = [
    'CODEX_COMMAND_TEMPLATE',
    'CODEX_COMMAND_TEMPLATE_RESUME',
    'CODEX_COMMAND',
    'CODEX_ARGS',
    'CODEX_PROMPT_FLAG',
    'CODEX_RESUME_SUBCOMMAND',
    'OPENAI_MODEL',
    'OPENAI_API_KEY',
    'CODEX_WRAPPER_MODE'
  ]
    .map((name) => {
      const value =
        name === 'OPENAI_API_KEY'
          ? trimmedKey || String(process.env.OPENAI_API_KEY || '').trim()
          : String(process.env[name] || '').trim();
      if (!value) return '';
      return `export ${name}=${shellEscape(value)};`;
    })
    .filter(Boolean)
    .join(' ');
  const command = [
    'cd',
    shellEscape(WORKSPACE_ROOT_PATH),
    '&&',
    forwardedEnv,
    'node',
    '/app/worker/src/workspace-codex-runner.js',
    shellEscape(WORKSPACE_ROOT_PATH),
    shellEscape(threadId || '')
  ]
    .filter(Boolean)
    .join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [
      '-n',
      namespace,
      'exec',
      '-i',
      podName,
      '-c',
      'workspace',
      '--',
      'sh',
      '-lc',
      command
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code && code !== 0) {
        const err = new Error(stderr || stdout || `Workspace codex exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (parsed?.success === false) {
          const err = new Error(parsed.output || parsed.rawOutput || 'Workspace codex failed');
          err.stdout = parsed.rawOutput || '';
          err.stderr = parsed.output || '';
          reject(err);
          return;
        }
        resolve({
          output: parsed.output || '',
          threadId: parsed.threadId || ''
        });
      } catch (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function commitWorkspaceChanges(projectId, taskId) {
  const statusRes = await workspaceExec(
    projectId,
    `cd ${shellEscape(WORKSPACE_ROOT_PATH)} && git status --porcelain`
  );
  const status = String(statusRes.stdout || '').trim();
  if (!status) {
    return null;
  }
  await workspaceExec(
    projectId,
    `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git config user.name ${shellEscape(AUTHOR_NAME)}
git config user.email ${shellEscape(AUTHOR_EMAIL)}
git add -A
git commit -m ${shellEscape(`AI task ${taskId}`)}`
  );
  return workspaceCurrentCommit(projectId);
}

async function createBuild(projectId, environment, status, refCommit) {
  const result = await pool.query(
    `insert into builds (project_id, environment, status, ref_commit)
     values ($1, $2, $3, $4)
     returning id`,
    [projectId, environment, status, refCommit || null]
  );
  return result.rows[0].id;
}

async function finalizeBuild(buildId, status, log, refCommit) {
  const nextLog = log ? String(log) : null;
  const safeLog =
    nextLog && nextLog.length > BUILD_LOG_MAX_BYTES
      ? nextLog.slice(-BUILD_LOG_MAX_BYTES)
      : nextLog;
  await pool.query(
    `update builds set status = $1, build_log = coalesce($2, build_log), ref_commit = $3, updated_at = now()
     where id = $4`,
    [status, safeLog || null, refCommit || null, buildId]
  );
}

function monthStartUtc(monthKey) {
  const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

function nextMonthStartUtc(monthKey) {
  const start = monthStartUtc(monthKey);
  if (!start) return null;
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

function bytesToGb(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num / 1024 / 1024 / 1024) * 100) / 100;
}

function monthKeyFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

function nextMonthStartMs(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

async function addRuntimeUsage(ownerId, projectId, environment, month, runtimeMs) {
  if (!ownerId || !projectId || !environment) return;
  if (!runtimeMs || Number.isNaN(runtimeMs) || runtimeMs <= 0) return;
  await pool.query(
    `insert into runtime_usage (user_id, project_id, environment, month, runtime_ms)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, project_id, environment, month)
     do update set runtime_ms = runtime_usage.runtime_ms + excluded.runtime_ms,
                   updated_at = now()`,
    [ownerId, projectId, environment, month, Math.floor(runtimeMs)]
  );
}

async function recordRuntimeUsage(ownerId, projectId, environment, startMs, endMs) {
  if (!ownerId || !projectId || !environment) return;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
  if (endMs <= startMs) return;
  let cursor = startMs;
  while (cursor < endMs) {
    const monthEnd = nextMonthStartMs(cursor);
    const segmentEnd = Math.min(endMs, monthEnd);
    const segmentMs = segmentEnd - cursor;
    if (segmentMs > 0) {
      await addRuntimeUsage(ownerId, projectId, environment, monthKeyFromMs(cursor), segmentMs);
    }
    cursor = segmentEnd;
  }
}

async function getProjectBuildCount(projectId, monthKey) {
  const start = monthStartUtc(monthKey);
  const end = nextMonthStartUtc(monthKey);
  if (!start || !end) return 0;
  const result = await pool.query(
    `select count(*)::int as count
     from builds
     where project_id = $1
       and created_at >= $2
       and created_at < $3`,
    [projectId, start, end]
  );
  return Number(result.rows[0]?.count || 0);
}

async function ensureBuildLimitForProject(projectId, plan) {
  const limit = Number(plan?.limits?.builds || 0);
  if (!limit) return;
  const month = currentMonthKey();
  const count = await getProjectBuildCount(projectId, month);
  if (count >= limit) {
    const err = new Error('Build limit reached for this project.');
    err.code = 'plan_build_limit';
    err.plan = plan?.name || DEFAULT_USER_PLAN;
    err.limit = limit;
    err.count = count;
    err.month = month;
    throw err;
  }
}

async function getDatabaseSizeBytes(dbName) {
  if (!dbName) return 0;
  try {
    const result = await adminPool.query('select pg_database_size($1)::bigint as size_bytes', [dbName]);
    return Number(result.rows[0]?.size_bytes || 0);
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('does not exist')) return 0;
    throw err;
  }
}

async function ensureDbStorageLimitForProject(projectId, environment, plan) {
  const limitGb = Number(plan?.limits?.db_storage_gb || 0);
  if (!limitGb) return;
  const envRes = await pool.query(
    'select db_name from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  let dbName = envRes.rows[0]?.db_name || null;
  if (!dbName) {
    const projectRes = await pool.query('select short_id from projects where id = $1', [projectId]);
    const shortId = projectRes.rows[0]?.short_id;
    if (shortId) dbName = dbNameFor(shortId, environment);
  }
  if (!dbName) return;
  let sizeBytes = 0;
  try {
    sizeBytes = await getDatabaseSizeBytes(dbName);
  } catch (err) {
    console.warn('DB size check failed', err?.message || err);
    return;
  }
  if (sizeBytes >= limitGb * 1024 * 1024 * 1024) {
    const err = new Error('Database storage limit reached for this project.');
    err.code = 'plan_db_storage_limit';
    err.plan = plan?.name || DEFAULT_USER_PLAN;
    err.environment = environment;
    err.limit_gb = limitGb;
    err.used_gb = bytesToGb(sizeBytes);
    throw err;
  }
}

async function getBandwidthUsageBytes(projectId, monthKey) {
  try {
    const result = await pool.query(
      `select bytes_out::bigint as bytes_out
       from bandwidth_usage
       where project_id = $1 and month = $2`,
      [projectId, monthKey]
    );
    return Number(result.rows[0]?.bytes_out || 0);
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('bandwidth_usage')) return 0;
    throw err;
  }
}

async function ensureBandwidthLimitForProject(projectId, plan) {
  const limitGb = Number(plan?.limits?.bandwidth_gb || 0);
  if (!limitGb) return;
  const month = currentMonthKey();
  const usedBytes = await getBandwidthUsageBytes(projectId, month);
  if (usedBytes >= limitGb * 1024 * 1024 * 1024) {
    const err = new Error('Bandwidth limit reached for this project.');
    err.code = 'plan_bandwidth_limit';
    err.plan = plan?.name || DEFAULT_USER_PLAN;
    err.limit_gb = limitGb;
    err.used_gb = bytesToGb(usedBytes);
    err.month = month;
    throw err;
  }
}

async function enforcePlanUsageLimits(projectId, environment) {
  const plan = await getPlanForProject(projectId);
  await ensureBuildLimitForProject(projectId, plan);
  await ensureDbStorageLimitForProject(projectId, environment, plan);
  await ensureBandwidthLimitForProject(projectId, plan);
}

async function updateBuildStatus(projectId, environment, status, refCommit) {
  const now = new Date();
  let ownerId = null;
  let previousStatus = null;
  let previousLiveSince = null;
  let previousDeployedCommit = null;
  try {
    const projectRes = await pool.query('select owner_id from projects where id = $1', [projectId]);
    ownerId = projectRes.rows[0]?.owner_id || null;
    const envRes = await pool.query(
      'select build_status, live_since, deployed_commit from environments where project_id = $1 and name = $2',
      [projectId, environment]
    );
    if (envRes.rowCount > 0) {
      previousStatus = envRes.rows[0].build_status || null;
      previousLiveSince = envRes.rows[0].live_since
        ? new Date(envRes.rows[0].live_since).getTime()
        : null;
      previousDeployedCommit = envRes.rows[0].deployed_commit || null;
    }
  } catch (err) {
    console.error('Failed to load runtime usage metadata', err);
  }
  if (previousStatus === 'live' && Number.isFinite(previousLiveSince) && ownerId) {
    try {
      await recordRuntimeUsage(ownerId, projectId, environment, previousLiveSince, now.getTime());
    } catch (err) {
      console.error('Failed to update runtime usage', err);
    }
  }
  const nextLiveSince = status === 'live' ? now : null;
  const nextDeployedCommit =
    status === 'live' && refCommit ? refCommit : previousDeployedCommit;
  try {
    await pool.query(
      `insert into environments (project_id, name, build_status, deployed_commit, live_since)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, name)
       do update set build_status = excluded.build_status,
                     deployed_commit = excluded.deployed_commit,
                     live_since = excluded.live_since,
                     updated_at = now()`,
      [projectId, environment, status, nextDeployedCommit, nextLiveSince]
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('live_since')) {
      await pool.query(
        `insert into environments (project_id, name, build_status, deployed_commit)
         values ($1, $2, $3, $4)
         on conflict (project_id, name)
         do update set build_status = excluded.build_status,
                       deployed_commit = excluded.deployed_commit,
                       updated_at = now()`,
        [projectId, environment, status, nextDeployedCommit]
      );
    } else {
      throw err;
    }
  }
  emitProjectEvent(projectId, 'buildUpdated', {
    environment,
    status,
    refCommit: refCommit || null,
    updatedAt: new Date().toISOString()
  });
}

let reconcileRunning = false;

async function reconcileStuckBuilds() {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    const staleSeconds = Math.max(60, Math.round(BUILD_RECONCILE_STALE_MS / 1000));
    const result = await pool.query(
      `select b.id, b.project_id, b.environment, b.ref_commit, b.updated_at, p.name, p.short_id, p.project_slug
       from builds b
       join projects p on p.id = b.project_id
       where b.status = 'building'
         and b.updated_at < now() - $1::interval
       order by b.updated_at asc
       limit 10`,
      [`${staleSeconds} seconds`]
    );
    for (const row of result.rows) {
      const envRes = await pool.query(
        'select env_vars from environments where project_id = $1 and name = $2',
        [row.project_id, row.environment]
      );
      const envVars = envRes.rows[0]?.env_vars || {};
      const host = hostFor({ name: row.name, short_id: row.short_id, project_slug: row.project_slug }, row.environment);
      const appPort = Number(envVars.PORT || process.env.PORT || 3000);
      const healthy = await checkHealthOnce(row.project_id, row.environment, host, appPort);
      if (healthy) {
        await finalizeBuild(row.id, 'live', 'Reconciled via health check', row.ref_commit);
        await updateBuildStatus(row.project_id, row.environment, 'live', row.ref_commit);
      } else {
        await finalizeBuild(row.id, 'failed', 'Health check failed during reconcile', row.ref_commit);
        await updateBuildStatus(row.project_id, row.environment, 'failed', row.ref_commit);
      }
    }
  } catch (err) {
    console.error('Reconcile builds failed', err);
  } finally {
    reconcileRunning = false;
  }
}

let scaleToZeroRunning = false;

async function reconcileScaleToZero() {
  if (scaleToZeroRunning) return;
  const devThreshold = scaleToZeroThresholdMs('development');
  const testThreshold = scaleToZeroThresholdMs('testing');
  if (devThreshold <= 0 && testThreshold <= 0) return;
  scaleToZeroRunning = true;
  try {
    const result = await pool.query(
      `select e.project_id, e.name, e.deployed_commit, e.updated_at, e.live_since,
              w.preview_mode, w.state as workspace_state, w.last_verified_commit_sha,
              p.name as project_name, p.short_id, p.project_slug
       from environments e
       join projects p on p.id = e.project_id
       left join project_workspaces w
         on w.project_id = e.project_id
        and w.environment = e.name
       where e.build_status = 'live'
         and e.name in ('development', 'testing')`
    );
    const now = Date.now();
    for (const row of result.rows) {
      const threshold = scaleToZeroThresholdMs(row.name);
      if (threshold <= 0) continue;
      const liveSince = row.live_since ? new Date(row.live_since).getTime() : 0;
      const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      const referenceAt = liveSince || updatedAt;
      if (!referenceAt || Number.isNaN(referenceAt)) continue;
      if (now - referenceAt < threshold) continue;
      if (await hasActiveTasks(row.project_id, row.name)) continue;

      if (!isLocalPlatform() && row.name === 'development') {
        await syncRepoBundleFromWorkspace(row.project_id).catch((err) => {
          console.warn(`Repo bundle sync failed during scale-to-zero for ${row.project_id}`, err?.message || err);
        });
        await sleepWorkspace(row.project_id, { routeToVerified: false }).catch((err) => {
          console.warn(`Workspace sleep failed during scale-to-zero for ${row.project_id}`, err?.message || err);
        });
        emitProjectEvent(row.project_id, 'workspaceUpdated', {
          projectId: row.project_id,
          state: 'sleeping',
          preview_mode: row.preview_mode || 'workspace',
          verified_commit_sha: row.last_verified_commit_sha || row.deployed_commit || null
        });
      }

      const outcome = await scaleDeploymentToZero(row.project_id, row.name);
      if (outcome === 'failed') continue;
      await updateBuildStatus(
        row.project_id,
        row.name,
        'offline',
        row.deployed_commit || null
      );
    }
  } catch (err) {
    console.error('Scale to zero reconcile failed', err);
  } finally {
    scaleToZeroRunning = false;
  }
}

let workspaceReconcileRunning = false;

async function refreshWorkspaceHeartbeat(projectId) {
  try {
    const workspace = await loadWorkspace(projectId);
    const { stdout } = await workspaceExec(
      projectId,
      `cat ${shellEscape(path.posix.join(WORKSPACE_META_PATH, 'heartbeat'))}`
    );
    const raw = String(stdout || '').trim();
    if (!raw) return null;
    const heartbeatAt = new Date(raw);
    if (Number.isNaN(heartbeatAt.getTime())) return null;
    const fresh = Date.now() - heartbeatAt.getTime() <= WORKSPACE_HEARTBEAT_STALE_MS;
    const patch = {
      last_preview_heartbeat_at: heartbeatAt
    };
    if (fresh) {
      const currentCommit = await workspaceCurrentCommit(projectId).catch(() => '');
      const dirty = await workspaceIsDirty(projectId).catch(() => false);
      const verifiedCommit = await environmentDeployedCommit(projectId).catch(() => '');
      patch.workspace_dirty = dirty;
      if (currentCommit) patch.current_commit_sha = currentCommit;
      if (verifiedCommit && (workspace?.last_verified_commit_sha !== verifiedCommit || workspace?.preview_mode === 'verified')) {
        patch.last_verified_commit_sha = verifiedCommit;
      }
    }
    await upsertWorkspace(projectId, patch);
    return heartbeatAt;
  } catch {
    return null;
  }
}

async function reconcileWorkspaces() {
  if (workspaceReconcileRunning || isLocalPlatform()) return;
  workspaceReconcileRunning = true;
  try {
    const result = await pool.query(
      `select project_id, state, idle_expires_at, last_verified_commit_sha
         from project_workspaces
        where environment = 'development'
          and state in ('starting', 'ready', 'failed')`
    );
    const now = Date.now();
    for (const row of result.rows) {
      const heartbeatAt = await refreshWorkspaceHeartbeat(row.project_id);
      if (heartbeatAt && now - heartbeatAt.getTime() <= WORKSPACE_HEARTBEAT_STALE_MS) {
        await restoreWorkspaceRouteIfNeeded(row.project_id).catch((err) => {
          console.warn(`Workspace route restore failed for ${row.project_id}`, err?.message || err);
        });
        continue;
      }
      const idleAt = row.idle_expires_at ? new Date(row.idle_expires_at).getTime() : 0;
      if (!idleAt || Number.isNaN(idleAt) || idleAt > now) continue;
      if (await hasActiveTasks(row.project_id, 'development')) continue;
      await syncRepoBundleFromWorkspace(row.project_id).catch((err) => {
        console.warn(`Repo bundle sync failed during sleep for ${row.project_id}`, err?.message || err);
      });
      await sleepWorkspace(row.project_id, { routeToVerified: Boolean(row.last_verified_commit_sha) });
      emitProjectEvent(row.project_id, 'workspaceUpdated', {
        projectId: row.project_id,
        state: 'sleeping',
        preview_mode: row.last_verified_commit_sha ? 'verified' : 'workspace'
      });
    }
  } catch (err) {
    console.error('Workspace reconcile failed', err);
  } finally {
    workspaceReconcileRunning = false;
  }
}

let devCrashHardRunning = false;

async function reconcileDevelopmentCrashHard() {
  if (devCrashHardRunning) return;
  if (!DEV_CRASH_HARD_ENABLED) return;
  devCrashHardRunning = true;
  try {
    const result = await pool.query(
      `select e.project_id, e.deployed_commit, e.latest_runtime_log_attempt_id::text as latest_runtime_log_attempt_id
       from environments e
       where e.build_status = 'live'
         and e.name = 'development'`
    );
    for (const row of result.rows) {
      const restartInfo = await detectRuntimeRestarts(row.project_id, 'development');
      if (!restartInfo) continue;
      const podLogs = await fetchPodLogs(row.project_id, 'development', HEALTHCHECK_LOG_LINES);
      const detail = [
        `Development runtime restart detected. Total restarts: ${restartInfo.totalRestarts}.`,
        restartInfo.summary ? `Restart summary:\n${restartInfo.summary}` : '',
        podLogs
          ? `Pod logs (last ${HEALTHCHECK_LOG_LINES} lines, latest + previous if available):\n${podLogs}`
          : 'Pod logs unavailable.'
      ]
        .filter(Boolean)
        .join('\n\n');
      await appendLatestRuntimeLog(
        row.project_id,
        'development',
        `[system] ${detail}\n`,
        row.latest_runtime_log_attempt_id || null
      );
      const outcome = await scaleDeploymentToZero(row.project_id, 'development');
      if (outcome === 'failed') {
        console.warn(`Development crash-hard: failed to scale deployment for project ${row.project_id}`);
        continue;
      }
      let buildId = null;
      try {
        buildId = await createBuild(row.project_id, 'development', 'failed', row.deployed_commit || null);
        await finalizeBuild(buildId, 'failed', detail, row.deployed_commit || null);
      } catch (err) {
        console.warn(`Development crash-hard: failed to persist build for ${row.project_id}`, err?.message || err);
      }
      await updateBuildStatus(row.project_id, 'development', 'failed', row.deployed_commit || null);
      await sendAlert(
        'dev_restart_hard_fail',
        'Development runtime restarted and was stopped',
        {
          project_id: row.project_id,
          environment: 'development',
          commit: row.deployed_commit || '',
          summary: truncateText(detail)
        },
        `${row.project_id}:development`
      );
      if (buildId) {
        await sendDeployWebhook(
          row.project_id,
          'development',
          'failed',
          row.deployed_commit || null,
          buildId,
          detail
        );
      }
    }
  } catch (err) {
    console.error('Development crash-hard reconcile failed', err);
  } finally {
    devCrashHardRunning = false;
  }
}

let runtimeLogCaptureRunning = false;

async function reconcileLatestRuntimeLogs() {
  if (runtimeLogCaptureRunning) return;
  runtimeLogCaptureRunning = true;
  try {
    const result = await pool.query(
      `select project_id, name, latest_runtime_log_attempt_id::text as latest_runtime_log_attempt_id
       from environments
       where build_status in ('building', 'live', 'canceling')`
    );
    const activeKeys = new Set();
    for (const row of result.rows) {
      const projectId = row.project_id;
      const environment = row.name;
      activeKeys.add(runtimeLogKey(projectId, environment));
      await captureLatestRuntimeLog(projectId, environment, row.latest_runtime_log_attempt_id || null);
    }
    for (const key of runtimeLogStreamState.keys()) {
      if (!activeKeys.has(key)) runtimeLogStreamState.delete(key);
    }
  } catch (err) {
    if (runtimeLogStorageUnsupported(err)) return;
    console.warn('Latest runtime log reconcile failed', err?.message || err);
  } finally {
    runtimeLogCaptureRunning = false;
  }
}

let runtimeQuotaRunning = false;

function quotaEnvironments() {
  const envs = new Set();
  for (const plan of Object.values(RUNTIME_QUOTAS || {})) {
    if (!plan || typeof plan !== 'object') continue;
    for (const [env, hours] of Object.entries(plan)) {
      const value = Number(hours);
      if (value && value > 0) envs.add(String(env || '').toLowerCase());
    }
  }
  return Array.from(envs);
}

async function reconcileRuntimeQuotas() {
  if (runtimeQuotaRunning) return;
  const envs = quotaEnvironments();
  if (envs.length === 0) return;
  runtimeQuotaRunning = true;
  try {
    const result = await pool.query(
      `select e.project_id, e.name, e.deployed_commit,
              p.owner_id, p.short_id, p.project_slug, p.name as project_name,
              u.plan as user_plan
       from environments e
       join projects p on p.id = e.project_id
       join users u on u.id = p.owner_id
       where e.build_status = 'live'
         and e.name = any($1)`,
      [envs]
    );
    if (result.rowCount === 0) return;
    const groups = new Map();
    for (const row of result.rows) {
      const userId = row.owner_id;
      const env = String(row.name || '').toLowerCase();
      const key = `${userId}:${env}`;
      if (!groups.has(key)) {
        groups.set(key, {
          userId,
          environment: env,
          planName: row.user_plan || DEFAULT_USER_PLAN,
          rows: []
        });
      }
      groups.get(key).rows.push(row);
    }
    for (const group of groups.values()) {
      const quotaMs = runtimeQuotaMs(group.planName, group.environment);
      if (!quotaMs) continue;
      const usedMs = await getRuntimeUsageMsByUser(group.userId, group.environment);
      if (usedMs < quotaMs) continue;
      console.log(
        `Runtime quota exceeded for user ${group.userId} env ${group.environment}: ${usedMs}ms >= ${quotaMs}ms`
      );
      const usedHours = Math.round((usedMs / 36e5) * 10) / 10;
      const limitHours = Math.round((quotaMs / 36e5) * 10) / 10;
      for (const row of group.rows) {
        const outcome = await scaleDeploymentToZero(row.project_id, group.environment);
        if (outcome === 'failed') continue;
        await updateBuildStatus(row.project_id, group.environment, 'offline', row.deployed_commit || null);
        emitProjectEvent(row.project_id, 'runtimeQuotaExceeded', {
          projectId: row.project_id,
          environment: group.environment,
          plan: group.planName,
          used_hours: usedHours,
          limit_hours: limitHours
        });
      }
    }
  } catch (err) {
    console.error('Runtime quota reconcile failed', err);
  } finally {
    runtimeQuotaRunning = false;
  }
}

async function processTask(taskId) {
  console.log(`Processing task ${taskId}...`);
  const taskRes = await pool.query('select * from tasks where id = $1', [taskId]);
  if (taskRes.rowCount === 0) return;
  const task = taskRes.rows[0];
  const projectRes = await pool.query(
    'select id, codex_thread_id from projects where id = $1',
    [task.project_id]
  );
  if (projectRes.rowCount === 0) return;
  const project = projectRes.rows[0];

  await pool.query('update tasks set status = $1 where id = $2', ['running', taskId]);
  emitProjectEvent(task.project_id, 'taskUpdated', { id: taskId, status: 'running' });

  let codexOutput = '';
  let commitHash = null;
  let workspaceHead = '';
  let localRepoPath = '';
  let codexFailed = false;
  try {
    if (!isLocalPlatform()) {
      const existingWorkspace = await loadWorkspace(task.project_id);
      const hasStoredRepo = await projectHasStoredRepoSource(task.project_id);
      await ensureWorkspace(task.project_id, {
        hydrateFromStoredRepo: !existingWorkspace && hasStoredRepo
      });
      await workspaceExec(
        task.project_id,
        `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git config user.name ${shellEscape(AUTHOR_NAME)}
git config user.email ${shellEscape(AUTHOR_EMAIL)}
git checkout -B ai-task main >/dev/null 2>&1 || git checkout -B ai-task`
      );
      workspaceHead = await workspaceCurrentCommit(task.project_id);
    } else {
      const loaded = await ensureLocalProjectRepo(task.project_id, {
        hydrateFromStoredRepo: !(await localProjectRepoExists(task.project_id))
      });
      localRepoPath = loaded.repoPath;
      await runGit(['config', 'user.name', AUTHOR_NAME], localRepoPath);
      await runGit(['config', 'user.email', AUTHOR_EMAIL], localRepoPath);
      await runGit(['checkout', '-B', 'ai-task', 'main'], localRepoPath).catch(() => runGit(['checkout', '-B', 'ai-task'], localRepoPath));
    }

    const demoApiKey = await getDemoOpenAiKey(task.project_id);
    const { output, threadId } = isLocalPlatform()
      ? await runCodex(task.prompt, localRepoPath, project.codex_thread_id || '', demoApiKey)
      : await runCodexInWorkspace(task.prompt, task.project_id, project.codex_thread_id || '', demoApiKey);
    codexOutput = output;
    if (threadId && threadId !== project.codex_thread_id) {
      await pool.query('update projects set codex_thread_id = $1 where id = $2', [threadId, task.project_id]);
    }
  } catch (err) {
    codexOutput = `Codex failed: ${err.message}`;
    codexFailed = true;
    console.error(`Codex failed for task ${taskId}:`, err);
  }
  console.log(`Task ${taskId} codex output:`, codexOutput);
  if (codexFailed) {
    if (isLocalPlatform()) {
      if (localRepoPath) {
        await runGit(['checkout', 'main'], localRepoPath).catch(() => runGit(['checkout', '-B', 'main'], localRepoPath));
        await runGit(['branch', '-D', 'ai-task'], localRepoPath).catch(() => {});
      }
    } else {
      await workspaceExec(
        task.project_id,
        `set +e
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git checkout main >/dev/null 2>&1 || git checkout -B main >/dev/null 2>&1 || true
git branch -D ai-task >/dev/null 2>&1 || true`
      ).catch(() => {});
      workspaceHead = await workspaceCurrentCommit(task.project_id).catch(() => workspaceHead);
      const dirty = await workspaceIsDirty(task.project_id).catch(() => false);
      await upsertWorkspace(task.project_id, {
        current_commit_sha: workspaceHead || null,
        workspace_dirty: dirty,
        state: 'ready',
        idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS)
      }).catch(() => {});
    }
    await pool.query(
      `update tasks set status = $1, codex_output = $2, completed_at = now()
       where id = $3`,
      ['failed', codexOutput, taskId]
    );
    emitProjectEvent(task.project_id, 'taskUpdated', {
      id: taskId,
      status: 'failed',
      codex_output: codexOutput
    });
    return;
  }
  if (isLocalPlatform()) {
    if (!localRepoPath) {
      throw new Error('Local repository unavailable for task processing');
    }
    const status = await gitOutput(['status', '--porcelain'], localRepoPath);
    if (status) {
      await runGit(['add', '-A'], localRepoPath);
      await runGit(['commit', '-m', `AI task ${taskId}`], localRepoPath);
      commitHash = await gitOutput(['rev-parse', 'HEAD'], localRepoPath);
    }
    await runGit(['checkout', '-B', 'main'], localRepoPath);
    if (commitHash) {
      await runGit(['merge', '--ff-only', 'ai-task'], localRepoPath).catch(() => {});
      await syncRepoBundleFromRepoPath(task.project_id, localRepoPath, 'repo-updated');
    }
  } else {
    const committedHash = await commitWorkspaceChanges(task.project_id, taskId);
    await workspaceExec(
      task.project_id,
      `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git checkout main >/dev/null 2>&1 || git checkout -B main${committedHash ? `
git merge --ff-only ai-task >/dev/null 2>&1 || true` : ''}`
    );
    workspaceHead = await workspaceCurrentCommit(task.project_id);
    commitHash = committedHash || null;
    const dirty = await workspaceIsDirty(task.project_id);
    await upsertWorkspace(task.project_id, {
      current_commit_sha: workspaceHead || null,
      workspace_dirty: dirty,
      state: 'ready',
      idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS)
    });
    if (commitHash) {
      await syncRepoBundleFromWorkspace(task.project_id);
    }
  }
  if (!commitHash) {
    codexOutput = codexOutput
      ? `${codexOutput}\n\n[system] No code changes detected. Deploy skipped.`
      : '[system] No code changes detected. Deploy skipped.';
  }
  console.log(`Task ${taskId} commit hash:`, commitHash);

  await pool.query(
    `update tasks set status = $1, codex_output = $2, commit_hash = $3, completed_at = now()
     where id = $4`,
    ['completed', codexOutput, commitHash, taskId]
  );
  console.log(`Task ${taskId} completed with commit ${commitHash}`);
  emitProjectEvent(task.project_id, 'taskUpdated', {
    id: taskId,
    status: 'completed',
    commit_hash: commitHash,
    codex_output: codexOutput
  });
  const verifiedOnlyDeploys = await isVerifiedOnlyDeploysEnabled();
  if (!isLocalPlatform() && String(task.environment || '').toLowerCase() === 'development') {
    let previewMessage = '';
    let workspacePreviewReady = false;
    if (!verifiedOnlyDeploys) {
      try {
        await upsertWorkspace(task.project_id, {
          state: 'starting',
          preview_mode: 'workspace',
          selected_mode: 'workspace',
          selected_task_id: task.id,
          selected_commit_sha: commitHash || null,
          live_task_id: null,
          live_commit_sha: null,
          last_error: null
        });
        emitProjectEvent(task.project_id, 'workspaceUpdated', {
          projectId: task.project_id,
          state: 'starting',
          preview_mode: 'workspace',
          commit_sha: null,
          verified_commit_sha: null,
          live_task_id: null,
          live_commit_sha: null
        });
        if (commitHash) {
          await checkoutWorkspaceCommit(task.project_id, commitHash);
        }
        const preview = await startWorkspacePreview(task.project_id, {
          forceRestart: true,
          failurePreviewMode: 'workspace'
        });
        workspacePreviewReady = Boolean(preview.started);
        if (workspacePreviewReady) {
          await switchDevelopmentRoute(task.project_id, 'workspace');
          const liveCommit = await markDevelopmentPreviewLive(
            task.project_id,
            preview.commitSha || commitHash || null
          );
          await upsertWorkspace(task.project_id, {
            state: 'ready',
            preview_mode: 'workspace',
            selected_mode: 'workspace',
            current_commit_sha: liveCommit || preview.commitSha || commitHash || null,
            selected_task_id: task.id,
            selected_commit_sha: preview.commitSha || commitHash || null,
            live_task_id: task.id,
            live_commit_sha: liveCommit || preview.commitSha || commitHash || null,
            last_error: null
          });
          previewMessage = `[system] Workspace preview running from commit ${preview.commitSha || commitHash || 'unknown'}.`;
          emitProjectEvent(task.project_id, 'workspaceUpdated', {
            projectId: task.project_id,
            state: 'ready',
            preview_mode: 'workspace',
            commit_sha: liveCommit,
            live_task_id: task.id,
            live_commit_sha: liveCommit
          });
        } else {
          previewMessage = '[system] Workspace preview unavailable; falling back to verified development runtime.';
          emitProjectEvent(task.project_id, 'workspaceUpdated', {
            projectId: task.project_id,
            state: 'failed',
            preview_mode: 'verified',
            error: 'Preview command not detected for workspace'
          });
        }
      } catch (err) {
        previewMessage = `[system] Workspace preview failed; falling back to verified runtime: ${err?.message || err}`;
        emitProjectEvent(task.project_id, 'workspaceUpdated', {
          projectId: task.project_id,
          state: 'failed',
          preview_mode: 'verified',
          error: err?.message || String(err)
        });
      }
      if (previewMessage) {
        await appendLatestRuntimeLog(task.project_id, task.environment, `${previewMessage}\n`, null);
      }
    }
    if (commitHash) {
      if (verifiedOnlyDeploys || !workspacePreviewReady) {
        await processDeployCommit(task.project_id, task.environment, commitHash, {
          forceIngress: true,
          selectedMode: 'verified',
          selectedTaskId: task.id,
          selectedCommitHash: commitHash
        });
      } else {
        await enqueueVerifyDevelopmentWorkspace(task.project_id, commitHash);
      }
    }
    return;
  }

  let buildId = null;
  try {
    buildId = await createBuild(task.project_id, task.environment, 'building', null);
    await beginLatestRuntimeLogAttempt(task.project_id, task.environment, buildId);
    await updateBuildStatus(task.project_id, task.environment, 'building', null);
    const deployLog = await deployEnvironment(task.project_id, task.environment, commitHash, buildId);
    await finalizeBuild(buildId, 'live', deployLog, commitHash);
    await updateBuildStatus(task.project_id, task.environment, 'live', commitHash);
  } catch (err) {
    const cancelled = err?.code === 'build_cancelled';
    const buildLog = cancelled ? null : buildLogFromError(err);
    if (!cancelled) {
      await captureRuntimeFailureEvidence(task.project_id, task.environment, buildId || null);
    }
    await appendLatestRuntimeLog(
      task.project_id,
      task.environment,
      `${cancelled ? '[system] Build cancelled by user.' : `[system] Deploy failed: ${buildLog}`}\n`,
      buildId || null
    );
    if (buildId) {
      await finalizeBuild(buildId, cancelled ? 'cancelled' : 'failed', buildLog, commitHash);
    }
    await updateBuildStatus(task.project_id, task.environment, cancelled ? 'cancelled' : 'failed', commitHash);
    throw err;
  }
}

async function processSaveSession(sessionId) {
  const sessionRes = await pool.query('select * from sessions where id = $1', [sessionId]);
  if (sessionRes.rowCount === 0) return;
  const session = sessionRes.rows[0];
  let mergeHash = null;

  if (!isLocalPlatform()) {
    const existingWorkspace = await loadWorkspace(session.project_id);
    const hasStoredRepo = await projectHasStoredRepoSource(session.project_id);
    await ensureWorkspace(session.project_id, {
      hydrateFromStoredRepo: !existingWorkspace && hasStoredRepo
    });
    await workspaceExec(
      session.project_id,
      `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git config user.name ${shellEscape(AUTHOR_NAME)}
git config user.email ${shellEscape(AUTHOR_EMAIL)}
git checkout main >/dev/null 2>&1 || git checkout -B main
git merge --no-ff ai-task -m ${shellEscape(session.message)} >/dev/null 2>&1 || true
git checkout -B ai-task
git reset --hard main >/dev/null 2>&1`
    );
    mergeHash = await workspaceCurrentCommit(session.project_id);
    if (mergeHash) {
      await syncRepoBundleFromWorkspace(session.project_id);
    }
    await upsertWorkspace(session.project_id, {
      current_commit_sha: mergeHash || null,
      workspace_dirty: await workspaceIsDirty(session.project_id),
      state: 'ready',
      idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS),
      last_error: null
    });
  } else {
    const loaded = await ensureLocalProjectRepo(session.project_id, {
      hydrateFromStoredRepo: !(await localProjectRepoExists(session.project_id))
    });
    await runGit(['checkout', 'main'], loaded.repoPath);
    await runGit(['merge', '--no-ff', 'ai-task', '-m', session.message], loaded.repoPath);
    mergeHash = await gitOutput(['rev-parse', 'HEAD'], loaded.repoPath);
    await runGit(['checkout', 'ai-task'], loaded.repoPath);
    await runGit(['reset', '--hard', 'main'], loaded.repoPath);
    await syncRepoBundleFromRepoPath(session.project_id, loaded.repoPath, 'repo-updated');
  }

  await pool.query('update sessions set merge_commit = $1 where id = $2', [mergeHash, sessionId]);
  await pool.query(
    `update tasks
     set session_id = $1
     where project_id = $2 and session_id is null and status = 'completed' and created_at <= $3`,
    [sessionId, session.project_id, session.created_at]
  );
}

async function processDeleteLatestTask(projectId) {
  const taskRes = await pool.query(
    `select * from tasks
     where project_id = $1
     order by created_at desc
     limit 1`,
    [projectId]
  );
  if (taskRes.rowCount === 0) throw new Error('No task to delete');
  const task = taskRes.rows[0];

  if (task.status !== 'completed' || !task.commit_hash) {
    await pool.query('delete from tasks where id = $1', [task.id]);
    emitProjectEvent(projectId, 'taskDeleted', { id: task.id });
    return;
  }
  await cancelSupersededDevelopmentWork(
    projectId,
    '\n\n[system] Cancel requested because the latest development task was deleted.\n'
  );
  let targetCommit = null;
  if (!isLocalPlatform()) {
    const existingWorkspace = await loadWorkspace(projectId);
    const hasStoredRepo = await projectHasStoredRepoSource(projectId);
    await ensureWorkspace(projectId, {
      hydrateFromStoredRepo: !existingWorkspace && hasStoredRepo
    });
    if (!task.session_id) {
      await workspaceExec(
        projectId,
        `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git checkout main >/dev/null 2>&1 || git checkout -B main
git reset --hard ${shellEscape(`${task.commit_hash}^`)} >/dev/null 2>&1
git checkout -B ai-task
git reset --hard main >/dev/null 2>&1`
      );
    } else {
      await workspaceExec(
        projectId,
        `set -eu
cd ${shellEscape(WORKSPACE_ROOT_PATH)}
git checkout main >/dev/null 2>&1 || git checkout -B main
git revert --no-edit ${shellEscape(task.commit_hash)} >/dev/null 2>&1
git checkout -B ai-task
git reset --hard main >/dev/null 2>&1`
      );
    }
    targetCommit = await workspaceCurrentCommit(projectId);
    if (targetCommit) {
      await syncRepoBundleFromWorkspace(projectId);
    }
    await upsertWorkspace(projectId, {
      current_commit_sha: targetCommit || null,
      workspace_dirty: await workspaceIsDirty(projectId),
      state: 'ready',
      idle_expires_at: new Date(Date.now() + WORKSPACE_IDLE_TTL_MS),
      last_error: null
    });
  } else {
    const loaded = await ensureLocalProjectRepo(projectId, {
      hydrateFromStoredRepo: !(await localProjectRepoExists(projectId))
    });
    const repoPath = loaded.repoPath;
    if (!task.session_id) {
      await runGit(['checkout', 'main'], repoPath);
      await runGit(['reset', '--hard', `${task.commit_hash}^`], repoPath);
      await runGit(['checkout', '-B', 'ai-task'], repoPath);
      await runGit(['reset', '--hard', 'main'], repoPath);
    } else {
      await runGit(['checkout', 'main'], repoPath);
      await runGit(['revert', '--no-edit', task.commit_hash], repoPath);
      await runGit(['checkout', '-B', 'ai-task'], repoPath);
      await runGit(['reset', '--hard', 'main'], repoPath);
    }
    targetCommit = await gitOutput(['rev-parse', 'HEAD'], repoPath);
    await syncRepoBundleFromRepoPath(projectId, repoPath, 'repo-updated');
  }

  await pool.query('delete from tasks where id = $1', [task.id]);
  emitProjectEvent(projectId, 'taskDeleted', { id: task.id });

  if (!targetCommit) {
    console.log(`Deleted task ${task.id} for project ${projectId} with no remaining target commit`);
    return;
  }

  const verifiedOnlyDeploys = await isVerifiedOnlyDeploysEnabled();
  if (!isLocalPlatform()) {
    let workspacePreviewReady = false;
    if (!verifiedOnlyDeploys) {
      try {
        await upsertWorkspace(projectId, {
          state: 'starting',
          preview_mode: 'workspace',
          selected_mode: 'workspace',
          selected_task_id: null,
          selected_commit_sha: targetCommit || null,
          live_task_id: null,
          live_commit_sha: null,
          last_error: null
        });
        emitProjectEvent(projectId, 'workspaceUpdated', {
          projectId,
          state: 'starting',
          preview_mode: 'workspace',
          commit_sha: null,
          verified_commit_sha: null,
          live_task_id: null,
          live_commit_sha: null
        });
        await checkoutWorkspaceCommit(projectId, targetCommit);
        const preview = await startWorkspacePreview(projectId, {
          forceRestart: true,
          failurePreviewMode: 'workspace'
        });
        workspacePreviewReady = Boolean(preview.started);
        if (workspacePreviewReady) {
          await switchDevelopmentRoute(projectId, 'workspace');
          const liveCommit = await markDevelopmentPreviewLive(
            projectId,
            preview.commitSha || targetCommit || null
          );
          await upsertWorkspace(projectId, {
            state: 'ready',
            preview_mode: 'workspace',
            selected_mode: 'workspace',
            current_commit_sha: liveCommit || preview.commitSha || targetCommit || null,
            selected_task_id: null,
            selected_commit_sha: preview.commitSha || targetCommit || null,
            live_task_id: null,
            live_commit_sha: liveCommit || preview.commitSha || targetCommit || null,
            last_error: null
          });
          emitProjectEvent(projectId, 'workspaceUpdated', {
            projectId,
            state: 'ready',
            preview_mode: 'workspace',
            commit_sha: liveCommit,
            live_task_id: null,
            live_commit_sha: liveCommit
          });
        }
      } catch (err) {
        console.warn(`Workspace preview refresh failed after deleting task for ${projectId}`, err?.message || err);
      }
    }
    if (verifiedOnlyDeploys || !workspacePreviewReady) {
      await processDeployCommit(projectId, 'development', targetCommit, {
        forceIngress: true,
        selectedMode: 'verified',
        selectedTaskId: null,
        selectedCommitHash: targetCommit
      });
    } else {
      await enqueueVerifyDevelopmentWorkspace(projectId, targetCommit);
    }
    return;
  }

  await processDeployCommit(projectId, 'development', targetCommit);
}

async function processEmptyDb(projectId, environment) {
  const buildId = await createBuild(projectId, environment, 'building', null);
  await updateBuildStatus(projectId, environment, 'building', null);
  const envRes = await pool.query(
    'select db_name from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  const projectRes = await pool.query('select short_id from projects where id = $1', [projectId]);
  const shortId = projectRes.rows[0]?.short_id;
  if (!shortId) {
    await updateBuildStatus(projectId, environment, 'failed', null);
    throw new Error('Project not found');
  }
  const dbName = envRes.rows[0]?.db_name || dbNameFor(shortId, environment);
  try {
    await resetDatabase(dbName);
    await finalizeBuild(buildId, 'live', `Database reset for ${dbName}`, null);
    await updateBuildStatus(projectId, environment, 'live', null);
  } catch (err) {
    await finalizeBuild(buildId, 'failed', err.message, null);
    await updateBuildStatus(projectId, environment, 'failed', null);
    throw err;
  }
}

async function processDeployCommit(projectId, environment, commitHash, options = {}) {
  await enforcePlanUsageLimits(projectId, environment);
  const buildId = await createBuild(projectId, environment, 'building', commitHash || null);
  await beginLatestRuntimeLogAttempt(projectId, environment, buildId);
  await updateBuildStatus(projectId, environment, 'building', commitHash || null);
  const deployOptions = {};
  try {
    if (!isLocalPlatform() && String(environment || '').toLowerCase() === 'development') {
      deployOptions.source = options.source || 'workspace';
      deployOptions.skipIngress = options.forceIngress ? false : (await isVerifiedOnlyDeploysEnabled() ? false : true);
      if (deployOptions.source === 'workspace') {
        const prepared = await prepareDevelopmentWorkspaceForDeploy(projectId, commitHash || '');
        if (!commitHash) {
          commitHash = prepared.currentCommit || null;
        }
        if (commitHash && !prepared.targetAvailable) {
          console.warn(
            `Requested commit ${commitHash} is unavailable in workspace for ${projectId}; falling back to snapshot source`
          );
          deployOptions.source = 'snapshot';
        }
      }
    }
    await ensureBuildNotCancelled(buildId);
    let log = null;
    if (await shouldFastResume(projectId, environment, commitHash || null)) {
      log = await fastResumeEnvironment(projectId, environment, commitHash || null, buildId);
    }
    if (!log) {
      log = await deployEnvironment(projectId, environment, commitHash || null, buildId, deployOptions);
    }
    await finalizeBuild(buildId, 'live', log, commitHash || null);
    await updateBuildStatus(projectId, environment, 'live', commitHash || null);
    if (!isLocalPlatform() && String(environment || '').toLowerCase() === 'development') {
      const cacheMeta = commitHash
        ? (options.cacheMeta || await computeDevelopmentFullBuildCacheMeta(projectId, commitHash))
        : {};
      await upsertWorkspace(projectId, {
        last_verified_commit_sha: commitHash || null,
        preview_mode: deployOptions.skipIngress ? 'workspace' : 'verified',
        state: 'ready',
        selected_mode: options.selectedMode
          ? normalizeDevelopmentMode(options.selectedMode)
          : (deployOptions.skipIngress ? 'workspace' : 'verified'),
        selected_task_id: Object.prototype.hasOwnProperty.call(options, 'selectedTaskId')
          ? (options.selectedTaskId || null)
          : undefined,
        selected_commit_sha: Object.prototype.hasOwnProperty.call(options, 'selectedCommitHash')
          ? (options.selectedCommitHash || null)
          : (commitHash || null),
        live_task_id: deployOptions.skipIngress
          ? undefined
          : (Object.prototype.hasOwnProperty.call(options, 'selectedTaskId') ? (options.selectedTaskId || null) : null),
        live_commit_sha: deployOptions.skipIngress ? undefined : (commitHash || null),
        full_build_image_ref: imageRefForBuild(projectId, environment, deployTagForBuild(commitHash || '', buildId)) || null,
        full_build_commit_sha: commitHash || null,
        full_build_cache_key: cacheMeta.cacheKey || null,
        full_build_built_at: commitHash ? new Date() : undefined,
        workspace_dirty: await workspaceIsDirty(projectId)
      });
      if (!deployOptions.skipIngress) {
        await switchDevelopmentRoute(projectId, 'verified');
      }
    }
    await sendDeployWebhook(projectId, environment, 'live', commitHash || null, buildId, '');
  } catch (err) {
    if (err?.code === 'build_cancelled') {
      await appendBuildLog(buildId, '\n\n[system] Build cancelled by user.\n');
      await appendLatestRuntimeLog(projectId, environment, '[system] Build cancelled by user.\n', buildId);
      await finalizeBuild(buildId, 'cancelled', null, commitHash || null);
      await updateBuildStatus(projectId, environment, 'cancelled', commitHash || null);
      await scaleDeploymentToZero(projectId, environment);
      return;
    }
    await captureRuntimeFailureEvidence(projectId, environment, buildId);
    if (err?.code === 'healthcheck_failed') {
      const summary = truncateText(err.detail || err.message || '');
      await sendAlert(
        'healthcheck_failed',
        `Health check failed`,
        {
          project_id: projectId,
          environment,
          host: err.host,
          commit: commitHash || '',
          summary
        },
        `${projectId}:${environment}`
      );
    }
    if (err?.code === 'healthcheck_failed' || err?.code === 'deploy_failed_fast') {
      await scaleDeploymentToZero(projectId, environment);
    }
    const buildLog =
      err?.code === 'healthcheck_failed' || err?.code === 'deploy_failed_fast'
        ? `${err.message}\n\n${err.detail || ''}`.trim()
        : buildLogFromError(err);
    await appendLatestRuntimeLog(
      projectId,
      environment,
      `[system] Deploy failed: ${buildLog}\n`,
      buildId
    );
    if (err?.code === 'healthcheck_failed') {
      await appendBuildLog(buildId, `\n\n[system] ${buildLog}\n`);
    }
    if (err?.code === 'deploy_failed_fast') {
      await appendBuildLog(buildId, `\n\n[system] ${buildLog}\n`);
    }
    await sendDeployWebhook(projectId, environment, 'failed', commitHash || null, buildId, buildLog);
    await finalizeBuild(buildId, 'failed', err?.code === 'healthcheck_failed' ? null : buildLog, commitHash || null);
    await updateBuildStatus(projectId, environment, 'failed', commitHash || null);
    throw err;
  }
}

async function processVerifyDevelopmentWorkspace(projectId, commitHash, options = {}) {
  const activateOnSuccess = Boolean(options.activateOnSuccess);
  const targetTaskId = options.taskId || null;
  const cacheMeta = options.cacheMeta || {};
  await enforcePlanUsageLimits(projectId, 'development');
  const buildId = await createBuild(projectId, 'development', 'building', commitHash || null);
  await beginLatestRuntimeLogAttempt(projectId, 'development', buildId);
  try {
    await ensureBuildNotCancelled(buildId);
    const log = await deployEnvironment(projectId, 'development', commitHash || null, buildId, {
      source: 'workspace',
      skipIngress: true
    });
    await finalizeBuild(buildId, 'live', log, commitHash || null);
    const currentCommit = await workspaceCurrentCommit(projectId);
    const dirty = await workspaceIsDirty(projectId);
    const nextCacheKey = cacheMeta.cacheKey || (await computeDevelopmentFullBuildCacheMeta(projectId, commitHash)).cacheKey;
    const imageRef = cacheMeta.imageRef || imageRefForBuild(
      projectId,
      'development',
      deployTagForBuild(commitHash || '', buildId)
    );
    await upsertWorkspace(projectId, {
      last_verified_commit_sha: commitHash || null,
      current_commit_sha: currentCommit || null,
      full_build_image_ref: imageRef || null,
      full_build_commit_sha: commitHash || null,
      full_build_cache_key: nextCacheKey || null,
      full_build_built_at: new Date(),
      workspace_dirty: dirty,
      state: 'ready',
      last_error: null
    });
    const workspace = await loadWorkspace(projectId);
    const shouldActivateVerified =
      activateOnSuccess ||
      normalizeDevelopmentMode(workspace?.selected_mode) === 'verified';
    if (shouldActivateVerified) {
      await switchDevelopmentRoute(projectId, 'verified');
      await updateBuildStatus(projectId, 'development', 'live', commitHash || null);
      await upsertWorkspace(projectId, {
        preview_mode: 'verified',
        state: 'ready',
        selected_mode: activateOnSuccess ? 'verified' : (workspace?.selected_mode || 'verified'),
        selected_task_id: activateOnSuccess ? targetTaskId : (workspace?.selected_task_id || null),
        selected_commit_sha: activateOnSuccess ? (commitHash || null) : (workspace?.selected_commit_sha || commitHash || null),
        live_task_id: targetTaskId || workspace?.selected_task_id || null,
        live_commit_sha: commitHash || null,
        last_error: null
      });
      emitProjectEvent(projectId, 'workspaceUpdated', {
        projectId,
        state: 'ready',
        preview_mode: 'verified',
        commit_sha: currentCommit || null,
        verified_commit_sha: commitHash || null
      });
    } else {
      await appendBuildLog(buildId, '\n\n[system] Full build succeeded and is ready to use. Development remains in Preview Mode.\n');
      const previewHealthy = await isWorkspacePreviewHealthy(
        projectId,
        Number(workspace?.preview_port || WORKSPACE_SERVICE_PORT)
      );
      if (previewHealthy) {
        await switchDevelopmentRoute(projectId, 'workspace');
        const liveCommit = await markDevelopmentPreviewLive(projectId, currentCommit || commitHash || null);
        await upsertWorkspace(projectId, {
          preview_mode: 'workspace',
          live_task_id: workspace?.live_task_id || null,
          live_commit_sha: workspace?.live_commit_sha || liveCommit || null,
          last_error: null
        });
        emitProjectEvent(projectId, 'workspaceUpdated', {
          projectId,
          state: 'ready',
          preview_mode: 'workspace',
          commit_sha: liveCommit,
          verified_commit_sha: commitHash || null
        });
      } else {
        await appendBuildLog(
          buildId,
          '\n\n[system] Workspace preview is unhealthy, so Development cannot stay in Preview Mode.\n'
        );
        await upsertWorkspace(projectId, {
          preview_mode: workspace?.preview_mode || 'workspace',
          state: 'failed',
          last_error: 'Workspace preview unhealthy after verified build'
        });
        emitProjectEvent(projectId, 'workspaceUpdated', {
          projectId,
          state: 'failed',
          preview_mode: workspace?.preview_mode || 'workspace',
          commit_sha: currentCommit || null,
          verified_commit_sha: commitHash || null,
          error: 'Workspace preview unhealthy after verified build'
        });
      }
    }
  } catch (err) {
    await captureRuntimeFailureEvidence(projectId, 'development', buildId);
    const buildLog =
      err?.code === 'healthcheck_failed' || err?.code === 'deploy_failed_fast'
        ? `${err.message}\n\n${err.detail || ''}`.trim()
        : buildLogFromError(err);
    await appendLatestRuntimeLog(
      projectId,
      'development',
      `[system] Verified development build failed: ${buildLog}\n`,
      buildId
    );
    await finalizeBuild(buildId, 'failed', buildLog, commitHash || null);
    await upsertWorkspace(projectId, {
      state: 'ready',
      preview_mode: 'workspace',
      last_error: truncateText(buildLog, 3500)
    });
    emitProjectEvent(projectId, 'workspaceUpdated', {
      projectId,
      state: 'ready',
      preview_mode: 'workspace',
      verified_commit_sha: null,
      error: err?.message || String(err)
    });
    if (err?.code === 'healthcheck_failed' || err?.code === 'deploy_failed_fast') {
      await scaleDeploymentToZero(projectId, 'development');
    }
    throw err;
  }
}

async function enqueueVerifyDevelopmentWorkspace(projectId, commitHash) {
  if (!projectId || !commitHash) return;
  const delay = WORKSPACE_AUTO_VERIFY_DELAY_MS;
  await taskQueue.add(
    'verify-development-workspace',
    { projectId, commitHash },
    {
      jobId: `verify-development-${projectId}-${commitHash}`,
      ...(delay > 0 ? { delay } : {})
    }
  );
}

const worker = new Worker(
  'tasks',
  async (job) => {
    const projectId = await resolveJobProjectId(job);
    const handleJob = async () => {
      try {
      if (job.name === 'init-project') {
        const { projectId } = job.data;
        const projectRes = await pool.query('select short_id from projects where id = $1', [projectId]);
        const shortId = projectRes.rows[0]?.short_id;
        if (!shortId) throw new Error('Project not found');
        await pool.query('update projects set snapshot_status = $1 where id = $2', ['building', projectId]);
        emitProjectEvent(projectId, 'projectUpdated', { snapshotStatus: 'building' });
        const envs = ['development', 'testing', 'production'];
        for (const env of envs) {
          const dbName = dbNameFor(shortId, env);
          await ensureDatabase(dbName);
          const dbUrl = dbUrlFor(dbName);
          await pool.query(
            `insert into environments (project_id, name, build_status, db_name, db_url)
             values ($1, $2, 'offline', $3, $4)
             on conflict (project_id, name)
             do update set db_name = excluded.db_name, db_url = excluded.db_url`,
            [projectId, env, dbName, dbUrl]
          );
        }
        // Default app port for starter templates (can be overridden by user env vars).
        await pool.query(
          `update environments
           set env_vars = env_vars || jsonb_build_object('PORT', '3000')
           where project_id = $1
             and (env_vars ? 'PORT') is false`,
          [projectId]
        );
        if (!isLocalPlatform()) {
          await ensureWorkspace(projectId, { cloneStarter: true, state: 'ready' });
          const commitHash = await syncRepoBundleFromWorkspace(projectId);
          await pool.query('update projects set snapshot_status = $1 where id = $2', ['ready', projectId]);
          emitProjectEvent(projectId, 'projectUpdated', { snapshotStatus: 'ready' });
          const verifiedOnlyDeploys = await isVerifiedOnlyDeploysEnabled();
          let workspacePreviewReady = false;
      if (!verifiedOnlyDeploys) {
        try {
          const preview = await startWorkspacePreview(projectId, { forceRestart: true });
          workspacePreviewReady = Boolean(preview.started);
          if (workspacePreviewReady) {
            await switchDevelopmentRoute(projectId, 'workspace');
            const liveCommit = await markDevelopmentPreviewLive(
              projectId,
              preview.commitSha || commitHash || null
            );
            emitProjectEvent(projectId, 'workspaceUpdated', {
              projectId,
              state: 'ready',
              preview_mode: 'workspace',
              commit_sha: liveCommit
            });
          } else {
                emitProjectEvent(projectId, 'workspaceUpdated', {
                  projectId,
                  state: 'failed',
                  preview_mode: 'verified',
                  error: 'Preview command not detected for workspace'
                });
              }
            } catch (err) {
              emitProjectEvent(projectId, 'workspaceUpdated', {
                projectId,
                state: 'failed',
                preview_mode: 'verified',
                error: err?.message || String(err)
              });
            }
          }
          if (commitHash) {
            if (verifiedOnlyDeploys || !workspacePreviewReady) {
              await processDeployCommit(projectId, 'development', commitHash, { forceIngress: true });
            } else {
              await enqueueVerifyDevelopmentWorkspace(projectId, commitHash);
            }
          }
        } else {
          const loaded = await ensureLocalProjectRepo(projectId, {
            cloneStarter: true,
            forceHydrate: true
          });
          await runGit(['checkout', '-B', 'main'], loaded.repoPath);
          await syncRepoBundleFromRepoPath(projectId, loaded.repoPath, 'repo');
          const commitHash = await gitOutput(['rev-parse', 'HEAD'], loaded.repoPath).catch(() => '');
          await pool.query('update projects set snapshot_status = $1 where id = $2', ['ready', projectId]);
          emitProjectEvent(projectId, 'projectUpdated', { snapshotStatus: 'ready' });
          await processDeployCommit(projectId, 'development', commitHash || null);
        }
        return;
      }
      if (job.name === 'empty-db') {
        await processEmptyDb(job.data.projectId, job.data.environment);
        return;
      }
      if (job.name === 'save-session') {
        await processSaveSession(job.data.sessionId);
        return;
      }
      if (job.name === 'delete-latest-task') {
        await processDeleteLatestTask(job.data.projectId);
        return;
      }
      if (job.name === 'delete-project') {
        await processDeleteProject(job.data.projectId);
        return;
      }
      if (job.name === 'reset-workspace') {
        if (isLocalPlatform()) {
          const loaded = await ensureLocalProjectRepo(job.data.projectId, {
            hydrateFromStoredRepo: true,
            forceHydrate: true
          });
          const commitHash = await gitOutput(['rev-parse', 'HEAD'], loaded.repoPath).catch(() => '');
          await pool.query('update projects set snapshot_status = $1 where id = $2', ['ready', job.data.projectId]);
          emitProjectEvent(job.data.projectId, 'projectUpdated', { snapshotStatus: 'ready' });
          if (commitHash) {
            await processDeployCommit(job.data.projectId, 'development', commitHash, { forceIngress: true });
          }
          return;
        }
        const commitHash = await (async () => {
          await resetWorkspace(job.data.projectId);
          const nextCommit = await syncRepoBundleFromWorkspace(job.data.projectId);
          return nextCommit;
        })();
        const verifiedOnlyDeploys = await isVerifiedOnlyDeploysEnabled();
        let workspacePreviewReady = false;
        if (!verifiedOnlyDeploys) {
          try {
            const preview = await startWorkspacePreview(job.data.projectId, { forceRestart: true });
            workspacePreviewReady = Boolean(preview.started);
            if (workspacePreviewReady) {
              await switchDevelopmentRoute(job.data.projectId, 'workspace');
              const liveCommit = await markDevelopmentPreviewLive(
                job.data.projectId,
                preview.commitSha || commitHash || null
              );
              emitProjectEvent(job.data.projectId, 'workspaceUpdated', {
                projectId: job.data.projectId,
                state: 'ready',
                preview_mode: 'workspace',
                commit_sha: liveCommit
              });
            } else {
              emitProjectEvent(job.data.projectId, 'workspaceUpdated', {
                projectId: job.data.projectId,
                state: 'failed',
                preview_mode: 'verified',
                error: 'Preview command not detected for workspace'
              });
            }
          } catch (err) {
            emitProjectEvent(job.data.projectId, 'workspaceUpdated', {
              projectId: job.data.projectId,
              state: 'failed',
              preview_mode: 'verified',
              error: err?.message || String(err)
            });
          }
        }
        if (commitHash) {
          if (verifiedOnlyDeploys || !workspacePreviewReady) {
            await processDeployCommit(job.data.projectId, 'development', commitHash, { forceIngress: true });
          } else {
            await enqueueVerifyDevelopmentWorkspace(job.data.projectId, commitHash);
          }
        }
        return;
      }
      if (job.name === 'stop-environment') {
        await stopEnvironment(job.data.projectId, job.data.environment);
        return;
      }
      if (job.name === 'resume-development-preview') {
        await resumeDevelopmentPreview(job.data.projectId);
        return;
      }
      if (job.name === 'activate-development-selection') {
        await activateDevelopmentSelection(job.data.projectId, {
          mode: job.data.mode,
          taskId: job.data.taskId,
          commitHash: job.data.commitHash
        });
        return;
      }
      if (job.name === 'verify-development-preview') {
        await verifyDevelopmentPreview(job.data.projectId);
        return;
      }
      if (job.name === 'verify-development-workspace') {
        await processVerifyDevelopmentWorkspace(job.data.projectId, job.data.commitHash);
        return;
      }
      if (job.name === 'deploy-commit') {
        await processDeployCommit(job.data.projectId, job.data.environment, job.data.commitHash);
        return;
      }
      await processTask(job.data.taskId);
    } catch (err) {
      if (job.name === 'init-project') {
        await pool.query('update projects set snapshot_status = $1 where id = $2', ['failed', job.data.projectId]);
        emitProjectEvent(job.data.projectId, 'projectUpdated', { snapshotStatus: 'failed' });
      } else if (job.name === 'codex-task') {
        // Codex do this: Do not set task to failed if task status is completed, as the error may have occurred during deploy after successful codex changes; instead just log the error in codex_output
        const taskRes = await pool.query('select project_id, status, codex_output from tasks where id = $1', [job.data.taskId]);
        const taskRow = taskRes.rows[0];
        if (taskRow?.status === 'completed') {
          const nextOutput = taskRow.codex_output
            ? `${taskRow.codex_output}\n\nDeploy error: ${err.message}`
            : `Deploy error: ${err.message}`;
          await pool.query('update tasks set codex_output = $1 where id = $2', [nextOutput, job.data.taskId]);
          emitProjectEvent(taskRow.project_id, 'taskUpdated', {
            id: job.data.taskId,
            codex_output: nextOutput,
            error: err.message
          });
        } else {
          await pool.query(
            'update tasks set status = $1, codex_output = $2, completed_at = now() where id = $3',
            ['failed', err.message, job.data.taskId]
          );
          emitProjectEvent(taskRow?.project_id, 'taskUpdated', {
            id: job.data.taskId,
            status: 'failed',
            error: err.message
          });
        }
      } else if (job.name === 'reset-workspace') {
        emitProjectEvent(job.data.projectId, 'workspaceUpdated', {
          projectId: job.data.projectId,
          state: 'failed',
          preview_mode: 'verified',
          error: err?.message || String(err)
        });
      } else if (job.name === 'resume-development-preview') {
        emitProjectEvent(job.data.projectId, 'workspaceUpdated', {
          projectId: job.data.projectId,
          state: 'failed',
          preview_mode: 'workspace',
          error: err?.message || String(err)
        });
      } else if (job.name === 'activate-development-selection') {
        await upsertWorkspace(job.data.projectId, {
          state: 'failed',
          live_task_id: null,
          live_commit_sha: null,
          last_error: err?.message || String(err)
        }).catch(() => {});
        emitProjectEvent(job.data.projectId, 'workspaceUpdated', {
          projectId: job.data.projectId,
          state: 'failed',
          preview_mode: normalizeDevelopmentMode(job.data.mode) || 'workspace',
          live_task_id: null,
          live_commit_sha: null,
          error: err?.message || String(err)
        });
      }
      throw err;
      }
    };
    if (projectId) {
      return withProjectLock(projectId, handleJob);
    }
    return handleJob();
  },
  { connection, concurrency: WORKER_CONCURRENCY }
);

worker.on('failed', (job, err) => {
  console.error('Job failed', job?.id, err);
});

if (BUILD_RECONCILE_INTERVAL_MS > 0) {
  setInterval(() => {
    reconcileStuckBuilds();
  }, BUILD_RECONCILE_INTERVAL_MS);
}

if (SCALE_TO_ZERO_INTERVAL_MS > 0) {
  setInterval(() => {
    reconcileScaleToZero();
  }, SCALE_TO_ZERO_INTERVAL_MS);
}

if (WORKSPACE_RECONCILE_INTERVAL_MS > 0) {
  reconcileWorkspaces();
  setInterval(() => {
    reconcileWorkspaces();
  }, WORKSPACE_RECONCILE_INTERVAL_MS);
}

if (DEV_CRASH_HARD_ENABLED && DEV_CRASH_HARD_INTERVAL_MS > 0) {
  setInterval(() => {
    reconcileDevelopmentCrashHard();
  }, DEV_CRASH_HARD_INTERVAL_MS);
}

if (RUNTIME_LOG_CAPTURE_INTERVAL_MS > 0) {
  reconcileLatestRuntimeLogs();
  setInterval(() => {
    reconcileLatestRuntimeLogs();
  }, RUNTIME_LOG_CAPTURE_INTERVAL_MS);
}

if (RUNTIME_QUOTA_INTERVAL_MS > 0) {
  setInterval(() => {
    reconcileRuntimeQuotas();
  }, RUNTIME_QUOTA_INTERVAL_MS);
}

if (BANDWIDTH_RECONCILE_INTERVAL_MS > 0) {
  setInterval(() => {
    reconcileBandwidthLimits();
  }, BANDWIDTH_RECONCILE_INTERVAL_MS);
}

async function monitorQueueBacklog() {
  try {
    const [waiting, delayed, active] = await Promise.all([
      taskQueue.getWaitingCount(),
      taskQueue.getDelayedCount(),
      taskQueue.getActiveCount()
    ]);
    const backlog = waiting + delayed;
    if (backlog >= QUEUE_BACKLOG_THRESHOLD) {
      await sendAlert(
        'queue_backlog',
        `Task queue backlog: ${backlog}`,
        { waiting, delayed, active, threshold: QUEUE_BACKLOG_THRESHOLD },
        'queue'
      );
    }
  } catch (err) {
    console.warn('Queue backlog monitor failed', err?.message || err);
  }
}

if (QUEUE_MONITOR_INTERVAL_MS > 0) {
  setInterval(() => {
    monitorQueueBacklog();
  }, QUEUE_MONITOR_INTERVAL_MS);
}

async function purgeOldAlerts() {
  if (!ALERT_RETENTION_DAYS || ALERT_RETENTION_DAYS <= 0) return;
  try {
    await pool.query(
      `delete from admin_alerts
       where created_at < now() - $1::interval`,
      [`${Math.floor(ALERT_RETENTION_DAYS)} days`]
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (!msg.includes('admin_alerts')) {
      console.warn('Alert retention cleanup failed', err?.message || err);
    }
  }
}

if (ALERT_RETENTION_INTERVAL_MS > 0) {
  setInterval(() => {
    purgeOldAlerts();
  }, ALERT_RETENTION_INTERVAL_MS);
}
