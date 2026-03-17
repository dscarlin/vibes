import http from 'http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { runMigrations } from './migrate.js';
import { authenticateUser, registerUser, requireAuth, signToken } from './auth.js';
import { query } from './db.js';
import { taskQueue } from './queue.js';
import {
  browseDatabaseRows,
  databaseErrorPayload,
  executeDatabaseQuery,
  getDatabaseCatalog,
  getDatabaseObjectDetails,
  loadDatabaseHistory,
  writeDatabaseAudit
} from './database-ui.js';
import {
  bundleRepo,
  detectRepoRoot,
  ensureGitRepo,
  extractArchive,
  loadRepoFromBundleBuffer,
  removeTempDir,
  validateRepo
} from './repo.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const app = express();
const corsOriginRaw = String(config.corsOrigin || '').trim();
const corsOriginExtraRaw = String(config.corsOriginExtra || '').trim();
const corsOrigins = [corsOriginRaw, corsOriginExtraRaw]
  .flatMap((value) => String(value || '').split(','))
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = corsOrigins.length === 0 || corsOrigins.includes('*');
const corsOptions = allowAllOrigins
  ? { origin: true, credentials: false }
  : {
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true
    };
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
const upload = multer({ limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB || 50)) * 1024 * 1024 } });
const exec = promisify(execFile);
const AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'Vibes AI';
const AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'ai@vibes.local';

const DESKTOP_MIME = {
  '.dmg': 'application/x-apple-diskimage',
  '.msi': 'application/x-msi',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.appimage': 'application/octet-stream'
};
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMIN_UI_DIR = path.resolve(__dirname, 'admin');

async function resolveDesktopDownload(platform = 'mac') {
  const directPath = (config.desktopDownloadPath || '').trim();
  if (directPath) {
    return path.resolve(directPath);
  }
  const dir = (config.desktopDownloadDir || '').trim();
  if (!dir) return null;
  const targetDir = path.resolve(dir);
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const extMap = {
    mac: '.dmg',
    osx: '.dmg',
    windows: '.msi',
    win: '.msi',
    linux: '.AppImage'
  };
  const ext = extMap[String(platform || '').toLowerCase()] || '';
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (ext && !name.endsWith(ext)) continue;
    const fullPath = path.join(targetDir, name);
    const stat = await fs.stat(fullPath);
    files.push({ path: fullPath, mtime: stat.mtimeMs });
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].path;
}

async function runGit(args, cwd) {
  await exec('git', args, { cwd });
}

async function gitOutput(args, cwd) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function branchExists(repoPath, branch) {
  try {
    await exec('git', ['show-ref', '--verify', `refs/heads/${branch}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function listCommits(args, repoPath) {
  const output = await gitOutput(args, repoPath);
  if (!output) return [];
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function commitMessage(repoPath, hash) {
  return gitOutput(['show', '-s', '--format=%s', hash], repoPath);
}

async function commitTime(repoPath, hash) {
  return gitOutput(['show', '-s', '--format=%cI', hash], repoPath);
}
const DEMO_MODE = (process.env.DEMO_MODE || '').toLowerCase() === 'true';
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || '').trim();
const RATE_LIMIT_AUTH_WINDOW_MS = Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS || 15 * 60 * 1000);
const RATE_LIMIT_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX || 20);
const RATE_LIMIT_PUBLIC_WINDOW_MS = Number(process.env.RATE_LIMIT_PUBLIC_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_PUBLIC_MAX = Number(process.env.RATE_LIMIT_PUBLIC_MAX || 120);
const KUBECTL_TIMEOUT_MS = Number(process.env.KUBECTL_TIMEOUT_MS || 8000);
const ADMIN_METRICS_CACHE_TTL_MS = Number(process.env.ADMIN_METRICS_CACHE_TTL_MS || 15000);
const ADMIN_METRICS_CACHE_STALE_TTL_MS = Number(process.env.ADMIN_METRICS_CACHE_STALE_TTL_MS || 5 * 60 * 1000);
const RUNTIME_NAMESPACE_DEVELOPMENT =
  process.env.RUNTIME_NAMESPACE_DEVELOPMENT || process.env.DEVELOPMENT_NAMESPACE || 'vibes-development';
const RUNTIME_NAMESPACE_TESTING =
  process.env.RUNTIME_NAMESPACE_TESTING || process.env.TESTING_NAMESPACE || 'vibes-testing';
const RUNTIME_NAMESPACE_PRODUCTION =
  process.env.RUNTIME_NAMESPACE_PRODUCTION || process.env.PRODUCTION_NAMESPACE || 'vibes-production';
const ADMIN_RESTART_LOOP_THRESHOLD = (() => {
  const raw = Number(process.env.ADMIN_RESTART_LOOP_THRESHOLD || 2);
  if (!Number.isFinite(raw) || raw < 1) return 2;
  return Math.floor(raw);
})();

const PLAN_DEFINITIONS = {
  starter: {
    maxProjects: 1,
    environments: ['development'],
    mobileEnabled: false
  },
  builder: {
    maxProjects: 1,
    environments: ['development', 'testing'],
    mobileEnabled: true
  },
  business: {
    maxProjects: 1,
    environments: ['development', 'testing', 'production'],
    mobileEnabled: true
  },
  agency: {
    maxProjects: 10,
    environments: ['development', 'testing', 'production'],
    mobileEnabled: true
  }
};
const DEFAULT_PLAN = String(config.defaultUserPlan || 'starter').toLowerCase();

function normalizePlanName(plan) {
  const name = String(plan || '').toLowerCase();
  return PLAN_DEFINITIONS[name] ? name : DEFAULT_PLAN;
}

function resolvePlanLimits(planName) {
  const planKey = normalizePlanName(planName);
  const defaults = PLAN_LIMIT_DEFAULTS[planKey] || {};
  const overrides = PLAN_LIMITS[planKey] || {};
  return { ...defaults, ...overrides };
}

async function getUserPlan(userId) {
  try {
    const result = await query('select plan from users where id = $1', [userId]);
    const name = normalizePlanName(result.rows[0]?.plan || DEFAULT_PLAN);
    return { name, ...PLAN_DEFINITIONS[name], limits: resolvePlanLimits(name) };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('column') && msg.includes('plan')) {
      const name = normalizePlanName(DEFAULT_PLAN);
      return { name, ...PLAN_DEFINITIONS[name], limits: resolvePlanLimits(name) };
    }
    throw err;
  }
}

function planAllowsEnv(plan, env) {
  return plan.environments.includes(env);
}

function planAllowsMobile(plan) {
  return Boolean(plan.mobileEnabled);
}

async function enforceProjectLimit(userId, plan) {
  if (!plan?.maxProjects || plan.maxProjects < 0) return null;
  const result = await query('select count(*)::int as count from projects where owner_id = $1', [userId]);
  const count = Number(result.rows[0]?.count || 0);
  return count >= plan.maxProjects ? { limit: plan.maxProjects, count } : null;
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

const RUNTIME_QUOTAS = parseRuntimeQuotas(process.env.RUNTIME_QUOTAS || process.env.RUNTIME_QUOTAS_JSON || '');
const PLAN_LIMITS = (() => {
  const raw = String(process.env.PLAN_LIMITS || process.env.PLAN_LIMITS_JSON || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();
const PLAN_LIMIT_DEFAULTS = {
  starter: { builds: 60, db_storage_gb: 2, bandwidth_gb: 15 },
  builder: { builds: 160, db_storage_gb: 8, bandwidth_gb: 50 },
  business: { builds: 500, db_storage_gb: 40, bandwidth_gb: 250 },
  agency: { builds: 2000, db_storage_gb: 200, bandwidth_gb: 1000 }
};

function runtimeQuotaMs(planName, environment) {
  const planKey = normalizePlanName(planName);
  const planLimits = RUNTIME_QUOTAS[planKey] || {};
  const hoursRaw = planLimits[environment];
  const hours = Number(hoursRaw);
  if (!hours || Number.isNaN(hours) || hours <= 0) return null;
  return hours * 60 * 60 * 1000;
}

function runtimeQuotaHoursByPlan(planName) {
  const environments = ['development', 'testing', 'production'];
  const usage = {};
  for (const env of environments) {
    const quotaMs = runtimeQuotaMs(planName, env);
    usage[env] = quotaMs ? roundHours(quotaMs / 36e5) : null;
  }
  return usage;
}

function currentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
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

function roundHours(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

const rateLimitStore = new Map();
let rateLimitSweep = 0;

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.connection?.remoteAddress || 'unknown';
}

function pruneRateLimitStore(now) {
  if (now - rateLimitSweep < 30000) return;
  rateLimitSweep = now;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (!entry || now > entry.resetAt) rateLimitStore.delete(key);
  }
}

function rateLimit({ keyPrefix, windowMs, max }) {
  return (req, res, next) => {
    if (!max || max <= 0) return next();
    const now = Date.now();
    pruneRateLimitStore(now);
    const key = `${keyPrefix}:${getClientIp(req)}`;
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }
    entry.count += 1;
    rateLimitStore.set(key, entry);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      return res.status(429).json({
        error: 'rate_limited',
        retry_after_ms: Math.max(0, entry.resetAt - now)
      });
    }
    return next();
  };
}

const authRateLimit = rateLimit({
  keyPrefix: 'auth',
  windowMs: RATE_LIMIT_AUTH_WINDOW_MS,
  max: RATE_LIMIT_AUTH_MAX
});
const publicRateLimit = rateLimit({
  keyPrefix: 'public',
  windowMs: RATE_LIMIT_PUBLIC_WINDOW_MS,
  max: RATE_LIMIT_PUBLIC_MAX
});

async function getRuntimeUsageMs(userId, environment) {
  try {
    const month = currentMonthKey();
    const usageRes = await query(
      `select coalesce(sum(runtime_ms), 0)::bigint as runtime_ms
       from runtime_usage
       where user_id = $1 and environment = $2 and month = $3`,
      [userId, environment, month]
    );
    let totalMs = Number(usageRes.rows[0]?.runtime_ms || 0);
    const liveRes = await query(
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

async function ensureRuntimeQuota(req, res, environment) {
  const plan = await getUserPlan(req.user.userId);
  const quotaMs = runtimeQuotaMs(plan.name, environment);
  if (!quotaMs) return plan;
  const usedMs = await getRuntimeUsageMs(req.user.userId, environment);
  if (usedMs >= quotaMs) {
    res.status(403).json({
      error: 'plan_runtime_quota_exceeded',
      plan: plan.name,
      environment,
      limit_hours: Math.round((quotaMs / 36e5) * 10) / 10,
      used_hours: Math.round((usedMs / 36e5) * 10) / 10
    });
    return null;
  }
  return plan;
}

async function getProjectBuildCount(projectId, monthKey) {
  const start = monthStartUtc(monthKey);
  const end = nextMonthStartUtc(monthKey);
  if (!start || !end) return 0;
  const result = await query(
    `select count(*)::int as count
     from builds
     where project_id = $1
       and created_at >= $2
       and created_at < $3`,
    [projectId, start, end]
  );
  return Number(result.rows[0]?.count || 0);
}

async function ensureBuildLimit(req, res, projectId) {
  const plan = await getUserPlan(req.user.userId);
  const limit = Number(plan?.limits?.builds || 0);
  if (!limit) return plan;
  const month = currentMonthKey();
  const count = await getProjectBuildCount(projectId, month);
  if (count >= limit) {
    res.status(403).json({
      error: 'plan_build_limit',
      plan: plan.name,
      limit,
      count,
      month
    });
    return null;
  }
  return plan;
}

async function getDatabaseSizeBytes(dbName) {
  if (!dbName) return 0;
  const result = await query('select pg_database_size($1)::bigint as size_bytes', [dbName]);
  return Number(result.rows[0]?.size_bytes || 0);
}

async function ensureDbStorageLimit(req, res, projectId, environment) {
  const plan = await getUserPlan(req.user.userId);
  const limitGb = Number(plan?.limits?.db_storage_gb || 0);
  if (!limitGb) return plan;
  const envRes = await query(
    'select db_name from environments where project_id = $1 and name = $2',
    [projectId, environment]
  );
  const dbName = envRes.rows[0]?.db_name;
  if (!dbName) return plan;
  let sizeBytes = 0;
  try {
    sizeBytes = await getDatabaseSizeBytes(dbName);
  } catch (err) {
    console.warn('DB size check failed', err?.message || err);
    return plan;
  }
  const usedGb = bytesToGb(sizeBytes);
  if (sizeBytes >= limitGb * 1024 * 1024 * 1024) {
    res.status(403).json({
      error: 'plan_db_storage_limit',
      plan: plan.name,
      environment,
      limit_gb: limitGb,
      used_gb: usedGb
    });
    return null;
  }
  return plan;
}

async function getBandwidthUsageBytes(projectId, monthKey) {
  try {
    const result = await query(
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

async function ensureBandwidthLimit(req, res, projectId) {
  const plan = await getUserPlan(req.user.userId);
  const limitGb = Number(plan?.limits?.bandwidth_gb || 0);
  if (!limitGb) return plan;
  const month = currentMonthKey();
  const usedBytes = await getBandwidthUsageBytes(projectId, month);
  const usedGb = bytesToGb(usedBytes);
  if (usedBytes >= limitGb * 1024 * 1024 * 1024) {
    res.status(403).json({
      error: 'plan_bandwidth_limit',
      plan: plan.name,
      limit_gb: limitGb,
      used_gb: usedGb,
      month
    });
    return null;
  }
  return plan;
}

function adminKeyFingerprint(key) {
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

async function logAdminAction(req, action, meta = {}) {
  try {
    const mergedMeta = {
      ...meta,
      admin_user_id: req.user?.userId || null,
      admin_email: req.user?.email || null
    };
    await query(
      `insert into admin_audit_log (action, admin_key_fingerprint, ip, user_agent, path, method, meta)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        action,
        adminKeyFingerprint(req.adminKey),
        getClientIp(req),
        String(req.headers['user-agent'] || ''),
        req.originalUrl || req.url || '',
        req.method || '',
        JSON.stringify(mergedMeta)
      ]
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('admin_audit_log')) return;
    console.warn('Failed to write admin audit log', err?.message || err);
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(403).json({ error: 'admin_access_disabled' });
  const key = String(req.headers['x-admin-key'] || '').trim();
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'admin_forbidden' });
  }
  req.adminKey = key;
  return next();
}

function requirePlatformAdmin(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const tokenUserId = req.user?.userId || req.user?.id;
      if (!tokenUserId) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const result = await query('select is_platform_admin from users where id = $1', [tokenUserId]);
      if (!result.rows[0]?.is_platform_admin) {
        return res.status(403).json({ error: 'admin_forbidden' });
      }
      req.user.userId = tokenUserId;
      req.user.is_platform_admin = true;
      return next();
    } catch (err) {
      console.error('Admin check failed', err);
      return res.status(500).json({ error: 'admin_check_failed' });
    }
  });
}

function requireAdminAccess(req, res, next) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) {
    return requirePlatformAdmin(req, res, next);
  }
  return requireAdmin(req, res, next);
}

async function isDemoModeEnabled() {
  if (DEMO_MODE) return true;
  const result = await query('select value from settings where key = $1', ['demo_mode']);
  return result.rows[0]?.value === 'true';
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

const KUBECTL_BIN = process.env.KUBECTL_BIN || 'kubectl';
const NODEGROUP_MONTHLY_COSTS = (() => {
  const raw = String(process.env.NODEGROUP_MONTHLY_COSTS || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();

let adminMetricsCache = null;
let adminMetricsCacheAt = 0;
let adminMetricsInFlight = null;
let adminMetricsLastSuccessAt = null;
let adminMetricsLastError = null;

function parseCpuMilli(value) {
  if (!value) return 0;
  const match = String(value).match(/^([0-9.]+)([a-zA-Z]+)?$/);
  if (!match) return 0;
  const num = Number(match[1]);
  const unit = match[2] || '';
  if (!Number.isFinite(num)) return 0;
  if (unit === 'm') return num;
  if (unit === 'n') return num / 1e6;
  if (unit === 'u') return num / 1000;
  return num * 1000;
}

function parseMemMi(value) {
  if (!value) return 0;
  const match = String(value).match(/^([0-9.]+)([a-zA-Z]+)?$/);
  if (!match) return 0;
  const num = Number(match[1]);
  const unit = match[2] || '';
  if (!Number.isFinite(num)) return 0;
  switch (unit) {
    case 'Ki':
      return num / 1024;
    case 'Mi':
      return num;
    case 'Gi':
      return num * 1024;
    case 'Ti':
      return num * 1024 * 1024;
    case 'Pi':
      return num * 1024 * 1024 * 1024;
    case 'Ei':
      return num * 1024 * 1024 * 1024 * 1024;
    case 'K':
      return (num * 1000) / 1024 / 1024;
    case 'M':
      return (num * 1000 * 1000) / 1024 / 1024;
    case 'G':
      return (num * 1000 * 1000 * 1000) / 1024 / 1024;
    case 'T':
      return (num * 1000 * 1000 * 1000 * 1000) / 1024 / 1024;
    default:
      return num / 1024 / 1024;
  }
}

async function kubectlJson(args) {
  const { stdout } = await exec(KUBECTL_BIN, [...args, '-o', 'json'], {
    timeout: KUBECTL_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

async function kubectlHealthCheck() {
  const startedAt = Date.now();
  await exec(KUBECTL_BIN, ['get', '--raw=/healthz'], {
    timeout: KUBECTL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
  return Date.now() - startedAt;
}

function nodeGroupLabel(node) {
  const labels = node?.metadata?.labels || {};
  return (
    labels.nodegroup ||
    labels['eks.amazonaws.com/nodegroup'] ||
    labels['alpha.eksctl.io/nodegroup-name'] ||
    'unknown'
  );
}

app.get('/health', publicRateLimit, (req, res) => {
  res.json({ ok: true });
});

app.get('/downloads/desktop', publicRateLimit, async (req, res) => {
  try {
    const platform = String(req.query.platform || 'mac');
    const filePath = await resolveDesktopDownload(platform);
    if (!filePath) {
      return res.status(404).json({ error: 'Desktop download not configured' });
    }
    const ext = path.extname(filePath).toLowerCase();
    if (DESKTOP_MIME[ext]) {
      res.setHeader('Content-Type', DESKTOP_MIME[ext]);
    }
    return res.download(filePath, path.basename(filePath));
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Failed to download desktop app' });
  }
});

app.use('/admin/static', publicRateLimit, express.static(ADMIN_UI_DIR));
app.get(['/admin', '/admin/'], publicRateLimit, (req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'));
});

app.get('/settings/healthcheck', requireAuth, async (req, res) => {
  const keys = [
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
  ];
  const result = await query('select key, value from settings where key = any($1)', [keys]);
  const map = {};
  for (const row of result.rows) map[row.key] = row.value;
  res.json(map);
});

app.put('/settings/healthcheck', requireAuth, async (req, res) => {
  const allowed = new Set([
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
  ]);
  const updates = req.body || {};
  const entries = Object.entries(updates).filter(([key]) => allowed.has(key));
  for (const [key, value] of entries) {
    await query(
      `insert into settings (key, value)
       values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, String(value)]
    );
  }
  res.json({ ok: true });
});

app.delete('/settings/healthcheck', requireAuth, async (req, res) => {
  const keys = [
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
  ];
  await query('delete from settings where key = any($1)', [keys]);
  res.json({ ok: true });
});

app.get('/settings/demo-openai-key', requireAuth, async (req, res) => {
  const enabled = await isDemoModeEnabled();
  if (!enabled) return res.json({ enabled: false });
  const userId = req.user?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const result = await query('select openai_api_key from users where id = $1', [userId]);
  res.json({ enabled: true, openaiApiKey: result.rows[0]?.openai_api_key || '' });
});

app.put('/settings/demo-openai-key', requireAuth, async (req, res) => {
  const enabled = await isDemoModeEnabled();
  if (!enabled) return res.status(403).json({ error: 'demo mode disabled' });
  const userId = req.user?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const nextKey = String(req.body?.openaiApiKey || '').trim();
  await query('update users set openai_api_key = $1 where id = $2', [nextKey || null, userId]);
  res.json({ ok: true });
});

app.get('/settings/deployment-policy', requireAuth, async (req, res) => {
  const result = await query('select value from settings where key = $1', ['verified_only_deploys']);
  const raw = String(result.rows[0]?.value || '').trim().toLowerCase();
  const verifiedOnly = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
  res.json({ verifiedOnly });
});

app.put('/settings/deployment-policy', requireAuth, async (req, res) => {
  const raw = req.body?.verifiedOnly;
  const verifiedOnly = raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes' || raw === 'on';
  await query(
    `insert into settings (key, value)
     values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    ['verified_only_deploys', verifiedOnly ? 'true' : 'false']
  );
  res.json({ ok: true, verifiedOnly });
});

app.post('/auth/register', authRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  const demoUsers = (process.env.DEMO_USERS || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e);
  if (demoUsers.length > 0 && !demoUsers.includes(email.toLowerCase())) {
    return res.status(403).json({ error: 'Registration is not yet open but come back soon!' });
  }
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = await registerUser(email, password || null);
  const token = signToken({ userId: user.id, email: user.email });
  const planName = user.plan || DEFAULT_PLAN;
  res.json({
    token,
    user: {
      ...user,
      runtime_limits: runtimeQuotaHoursByPlan(planName)
    }
  });
});

app.post('/auth/login', authRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = await authenticateUser(email, password || null);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const token = signToken({ userId: user.id, email: user.email });
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan || DEFAULT_PLAN,
      is_platform_admin: Boolean(user.is_platform_admin),
      runtime_limits: runtimeQuotaHoursByPlan(user.plan || DEFAULT_PLAN)
    }
  });
});

app.get('/auth/me', requireAuth, async (req, res) => {
  const result = await query(
    'select id, email, plan, is_platform_admin from users where id = $1',
    [req.user.userId]
  );
  if (result.rowCount === 0) return res.status(401).json({ error: 'unauthorized' });
  const row = result.rows[0];
  res.json({
    user: {
      id: row.id,
      email: row.email,
      plan: row.plan || DEFAULT_PLAN,
      is_platform_admin: Boolean(row.is_platform_admin),
      runtime_limits: runtimeQuotaHoursByPlan(row.plan || DEFAULT_PLAN)
    }
  });
});

app.put('/admin/users/plan', requireAdminAccess, async (req, res) => {
  const { userId, email, plan } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan required' });
  const normalized = normalizePlanName(plan);
  if (!PLAN_DEFINITIONS[normalized]) {
    return res.status(400).json({ error: 'invalid plan' });
  }
  if (!userId && !email) {
    return res.status(400).json({ error: 'userId or email required' });
  }
  const result = userId
    ? await query(
        'update users set plan = $1 where id = $2 returning id, email, plan',
        [normalized, userId]
      )
    : await query(
        'update users set plan = $1 where lower(email) = lower($2) returning id, email, plan',
        [normalized, email]
      );
  if (result.rowCount === 0) return res.status(404).json({ error: 'user not found' });
  await logAdminAction(req, 'set_user_plan', {
    userId: result.rows[0].id,
    email: result.rows[0].email,
    plan: result.rows[0].plan
  });
  res.json({ ok: true, user: result.rows[0] });
});

app.get('/admin/runtime-usage', requireAdminAccess, async (req, res) => {
  const monthParam = String(req.query.month || '').trim();
  const month = monthParam || currentMonthKey();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'invalid_month' });
  }
  const monthStart = monthStartUtc(month);
  if (!monthStart) return res.status(400).json({ error: 'invalid_month' });

  const envKeys = ['development', 'testing', 'production'];
  let usageRows = [];
  try {
    const usageRes = await query(
      `select u.id as user_id, u.email, u.plan, ru.environment,
              coalesce(sum(ru.runtime_ms), 0)::bigint as runtime_ms
       from users u
       left join runtime_usage ru
         on ru.user_id = u.id and ru.month = $1
       group by u.id, u.email, u.plan, ru.environment
       order by lower(u.email), ru.environment`,
      [month]
    );
    usageRows = usageRes.rows;
  } catch (err) {
    const msg = String(err?.message || '');
    if (!msg.includes('runtime_usage')) throw err;
    const usersRes = await query(
      'select id as user_id, email, plan from users order by lower(email)'
    );
    usageRows = usersRes.rows.map((row) => ({ ...row, environment: null, runtime_ms: 0 }));
  }

  const userMap = new Map();
  for (const row of usageRows) {
    const userId = row.user_id;
    if (!userMap.has(userId)) {
      userMap.set(userId, {
        user_id: userId,
        email: row.email,
        plan: row.plan || DEFAULT_PLAN,
        usageMs: { development: 0, testing: 0, production: 0 }
      });
    }
    const env = row.environment;
    if (env && envKeys.includes(env)) {
      const runtimeMs = Number(row.runtime_ms || 0);
      userMap.get(userId).usageMs[env] += runtimeMs;
    }
  }

  if (month === currentMonthKey()) {
    try {
      const liveRes = await query(
        `select p.owner_id as user_id, e.name as environment, e.live_since
         from environments e
         join projects p on p.id = e.project_id
         where e.build_status = 'live'
           and e.live_since is not null`
      );
      const now = Date.now();
      const monthStartMs = monthStart.getTime();
      for (const row of liveRes.rows) {
        const env = row.environment;
        if (!envKeys.includes(env)) continue;
        const user = userMap.get(row.user_id);
        if (!user) continue;
        const liveSince = new Date(row.live_since).getTime();
        if (!Number.isFinite(liveSince)) continue;
        const start = Math.max(liveSince, monthStartMs);
        if (now > start) {
          user.usageMs[env] += now - start;
        }
      }
    } catch (err) {
      const msg = String(err?.message || '');
      if (!msg.includes('live_since')) throw err;
    }
  }

  const users = [];
  for (const user of userMap.values()) {
    const planName = normalizePlanName(user.plan || DEFAULT_PLAN);
    const usage = {};
    for (const env of envKeys) {
      const usedMs = user.usageMs[env] || 0;
      const limitMs = runtimeQuotaMs(planName, env);
      const usedHours = roundHours(usedMs / 36e5);
      const limitHours = limitMs ? roundHours(limitMs / 36e5) : null;
      const percent = limitMs
        ? Math.min(100, Math.round((usedMs / limitMs) * 1000) / 10)
        : null;
      usage[env] = {
        used_ms: usedMs,
        limit_ms: limitMs,
        used_hours: usedHours,
        limit_hours: limitHours,
        percent
      };
    }
    users.push({ user_id: user.user_id, email: user.email, plan: planName, usage });
  }

  await logAdminAction(req, 'runtime_usage_report', { month });
  res.json({ month, users });
});

app.get('/admin/audit-log', requireAdminAccess, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const action = String(req.query.action || '').trim();
  const since = String(req.query.since || '').trim();
  const clauses = [];
  const params = [];
  if (action) {
    params.push(action);
    clauses.push(`action = $${params.length}`);
  }
  if (since) {
    params.push(since);
    clauses.push(`created_at >= $${params.length}::timestamptz`);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  params.push(limit);
  const result = await query(
    `select id, action, admin_key_fingerprint, ip, user_agent, path, method, meta, created_at
     from admin_audit_log
     ${where}
     order by created_at desc
     limit $${params.length}`,
    params
  );
  res.json({ rows: result.rows });
});

app.get('/admin/alerts', requireAdminAccess, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const ack = String(req.query.ack || '0').toLowerCase();
  const type = String(req.query.type || '').trim();
  const level = String(req.query.level || '').trim();
  const search = String(req.query.search || '').trim();
  const params = [];
  const clauses = [];
  if (ack !== 'all') {
    if (ack === '1' || ack === 'true') {
      clauses.push('acknowledged_at is not null');
    } else {
      clauses.push('acknowledged_at is null');
    }
  }
  if (type) {
    params.push(type);
    clauses.push(`type = $${params.length}`);
  }
  if (level) {
    params.push(level);
    clauses.push(`level = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(message ilike $${params.length} or data::text ilike $${params.length})`);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  params.push(limit);
  const result = await query(
    `select id, type, level, message, data, acknowledged_at, acknowledged_by, created_at
     from admin_alerts
     ${where}
     order by created_at desc
     limit $${params.length}`,
    params
  );
  res.json({ rows: result.rows });
});

app.post('/admin/alerts/:alertId/ack', requireAdminAccess, async (req, res) => {
  const alertId = req.params.alertId;
  const result = await query(
    `update admin_alerts
     set acknowledged_at = now(), acknowledged_by = $1
     where id = $2
     returning id, acknowledged_at, acknowledged_by`,
    [req.user.userId, alertId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'alert_not_found' });
  await logAdminAction(req, 'admin_alert_ack', { alertId });
  res.json(result.rows[0]);
});

app.get('/admin/metrics', requireAdminAccess, async (req, res) => {
  const now = Date.now();
  if (adminMetricsCache && now - adminMetricsCacheAt < ADMIN_METRICS_CACHE_TTL_MS) {
    return res.json({
      ...adminMetricsCache,
      meta: {
        cached: true,
        stale: false,
        generated_at: adminMetricsCacheAt,
        age_ms: now - adminMetricsCacheAt,
        last_success_at: adminMetricsLastSuccessAt || adminMetricsCacheAt,
        last_error_at: adminMetricsLastError?.at || null
      }
    });
  }

  if (!adminMetricsInFlight) {
    adminMetricsInFlight = (async () => {
      const [nodes, pods] = await Promise.all([
        kubectlJson(['get', 'nodes']),
        kubectlJson(['get', 'pods', '-A'])
      ]);

      let queue = null;
      try {
        const counts = await taskQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        const waiting = counts.waiting || 0;
        const delayed = counts.delayed || 0;
        queue = {
          waiting,
          active: counts.active || 0,
          delayed,
          failed: counts.failed || 0,
          completed: counts.completed || 0,
          backlog: waiting + delayed,
          threshold: Number(process.env.QUEUE_BACKLOG_THRESHOLD || 5)
        };
      } catch (err) {
        queue = { error: err?.message || String(err) };
      }

      const totals = {
        nodes: nodes.items.length,
        cpu_m: 0,
        mem_mi: 0,
        alloc_cpu_m: 0,
        alloc_mem_mi: 0
      };
      const nodegroups = new Map();
      const nodeNameToGroup = new Map();
      const nodeNameToAlloc = new Map();
      for (const node of nodes.items) {
        const nodeName = node.metadata?.name || '';
        const capacity = node.status?.capacity || {};
        const alloc = node.status?.allocatable || {};
        const cpuM = parseCpuMilli(capacity.cpu);
        const memMi = parseMemMi(capacity.memory);
        const allocCpuM = parseCpuMilli(alloc.cpu);
        const allocMemMi = parseMemMi(alloc.memory);
        totals.cpu_m += cpuM;
        totals.mem_mi += memMi;
        totals.alloc_cpu_m += allocCpuM;
        totals.alloc_mem_mi += allocMemMi;

        const group = nodeGroupLabel(node);
        const existing = nodegroups.get(group) || {
          name: group,
          nodes: 0,
          cpu_m: 0,
          mem_mi: 0,
          alloc_cpu_m: 0,
          alloc_mem_mi: 0
        };
        existing.nodes += 1;
        existing.cpu_m += cpuM;
        existing.mem_mi += memMi;
        existing.alloc_cpu_m += allocCpuM;
        existing.alloc_mem_mi += allocMemMi;
        existing.monthly_cost = NODEGROUP_MONTHLY_COSTS[group] ?? null;
        nodegroups.set(group, existing);
        if (nodeName) {
          nodeNameToGroup.set(nodeName, group);
          nodeNameToAlloc.set(nodeName, { cpu_m: allocCpuM, mem_mi: allocMemMi });
        }
      }

      let requestedCpuM = 0;
      let requestedMemMi = 0;
      const nodegroupRequested = new Map();
      const podStatuses = {};
      const podIssues = {
        crash_loop: 0,
        restart_loop: 0,
        image_pull_backoff: 0,
        pending: 0,
        failed: 0
      };
      const crashLoopPods = [];
      const namespaceSummary = {};
      for (const pod of pods.items) {
        const phase = pod.status?.phase || 'Unknown';
        podStatuses[phase] = (podStatuses[phase] || 0) + 1;
        if (phase === 'Pending') podIssues.pending += 1;
        if (phase === 'Failed') podIssues.failed += 1;

        const ns = pod.metadata?.namespace || 'default';
        if (!namespaceSummary[ns]) {
          namespaceSummary[ns] = { total: 0, phases: {} };
        }
        namespaceSummary[ns].total += 1;
        namespaceSummary[ns].phases[phase] = (namespaceSummary[ns].phases[phase] || 0) + 1;

        const statuses = pod.status?.containerStatuses || [];
        let isCrashLoop = false;
        let hasCrashLoopBackoff = false;
        let hasImagePullIssue = false;
        let restartCount = 0;
        for (const status of statuses) {
          const reason = status.state?.waiting?.reason || '';
          if (reason === 'CrashLoopBackOff') hasCrashLoopBackoff = true;
          if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') hasImagePullIssue = true;
          restartCount += Number(status.restartCount || 0);
        }
        if (hasCrashLoopBackoff) podIssues.crash_loop += 1;
        if (hasImagePullIssue) podIssues.image_pull_backoff += 1;
        const hasUnreadyContainer = statuses.some((status) => !status.ready);
        const isRestartLoop =
          !hasCrashLoopBackoff &&
          hasUnreadyContainer &&
          restartCount >= ADMIN_RESTART_LOOP_THRESHOLD;
        if (isRestartLoop) podIssues.restart_loop += 1;
        isCrashLoop = hasCrashLoopBackoff || isRestartLoop;

        const containers = pod.spec?.containers || [];
        let podReqCpu = 0;
        let podReqMem = 0;
        for (const container of containers) {
          const reqs = container.resources?.requests || {};
          const cpuM = parseCpuMilli(reqs.cpu);
          const memMi = parseMemMi(reqs.memory);
          requestedCpuM += cpuM;
          requestedMemMi += memMi;
          podReqCpu += cpuM;
          podReqMem += memMi;
        }

        const nodeName = pod.spec?.nodeName || '';
        if (nodeName && podReqCpu + podReqMem > 0) {
          const group = nodeNameToGroup.get(nodeName) || 'unknown';
          const current = nodegroupRequested.get(group) || { cpu_m: 0, mem_mi: 0 };
          current.cpu_m += podReqCpu;
          current.mem_mi += podReqMem;
          nodegroupRequested.set(group, current);
        }

        if (isCrashLoop) {
          crashLoopPods.push({
            namespace: pod.metadata?.namespace || 'default',
            name: pod.metadata?.name || '',
            node: nodeName || '',
            restarts: restartCount,
            reason: hasCrashLoopBackoff ? 'CrashLoopBackOff' : 'RestartLoop'
          });
        }
      }

      crashLoopPods.sort((a, b) => b.restarts - a.restarts);

      const capacity = {
        requested_cpu_m: requestedCpuM,
        requested_mem_mi: Math.round(requestedMemMi * 10) / 10,
        alloc_cpu_m: totals.alloc_cpu_m,
        alloc_mem_mi: Math.round(totals.alloc_mem_mi * 10) / 10,
        cpu_percent: totals.alloc_cpu_m
          ? Math.round((requestedCpuM / totals.alloc_cpu_m) * 1000) / 10
          : null,
        mem_percent: totals.alloc_mem_mi
          ? Math.round((requestedMemMi / totals.alloc_mem_mi) * 1000) / 10
          : null
      };

      for (const group of nodegroups.values()) {
        const requested = nodegroupRequested.get(group.name) || { cpu_m: 0, mem_mi: 0 };
        group.requested_cpu_m = requested.cpu_m;
        group.requested_mem_mi = Math.round(requested.mem_mi * 10) / 10;
        group.cpu_percent = group.alloc_cpu_m
          ? Math.round((requested.cpu_m / group.alloc_cpu_m) * 1000) / 10
          : null;
        group.mem_percent = group.alloc_mem_mi
          ? Math.round((requested.mem_mi / group.alloc_mem_mi) * 1000) / 10
          : null;
      }

      const projectCounts = await query('select count(*)::int as count from projects');
      const envStatusRes = await query(
        `select name, build_status, count(*)::int as count
         from environments
         group by name, build_status`
      );
      const envStatus = { development: {}, testing: {}, production: {} };
      for (const row of envStatusRes.rows) {
        if (!envStatus[row.name]) envStatus[row.name] = {};
        envStatus[row.name][row.build_status] = row.count;
      }

      return {
        generated_at: new Date().toISOString(),
        nodes: {
          totals,
          by_nodegroup: Array.from(nodegroups.values()).sort((a, b) => b.nodes - a.nodes)
        },
        pods: {
          totals: podStatuses,
          issues: podIssues,
          namespaces: namespaceSummary,
          top_crashloops: crashLoopPods.slice(0, 10)
        },
        capacity,
        queue,
        projects: {
          total: projectCounts.rows[0]?.count || 0,
          environments: envStatus
        }
      };
    })();
  }

  try {
    const metrics = await adminMetricsInFlight;
    adminMetricsInFlight = null;
    adminMetricsCache = metrics;
    adminMetricsCacheAt = Date.now();
    adminMetricsLastSuccessAt = adminMetricsCacheAt;
    adminMetricsLastError = null;
    return res.json({
      ...metrics,
      meta: {
        cached: false,
        stale: false,
        generated_at: adminMetricsCacheAt,
        age_ms: 0,
        last_success_at: adminMetricsLastSuccessAt,
        last_error_at: null
      }
    });
  } catch (err) {
    adminMetricsInFlight = null;
    adminMetricsLastError = { at: Date.now(), message: err?.message || String(err) };
    if (adminMetricsCache && now - adminMetricsCacheAt < ADMIN_METRICS_CACHE_STALE_TTL_MS) {
      return res.json({
        ...adminMetricsCache,
        meta: {
          cached: true,
          stale: true,
          generated_at: adminMetricsCacheAt,
          age_ms: now - adminMetricsCacheAt,
          error: err?.message || String(err),
          last_success_at: adminMetricsLastSuccessAt || adminMetricsCacheAt,
          last_error_at: adminMetricsLastError.at
        }
      });
    }
    return res.status(500).json({
      error: 'kubectl_failed',
      message: err?.message || String(err),
      last_success_at: adminMetricsLastSuccessAt,
      last_error_at: adminMetricsLastError.at
    });
  }
});

app.get('/admin/metrics-health', requireAdminAccess, async (req, res) => {
  try {
    const latencyMs = await kubectlHealthCheck();
    return res.json({
      ok: true,
      latency_ms: latencyMs,
      last_success_at: adminMetricsLastSuccessAt,
      last_error_at: adminMetricsLastError?.at || null
    });
  } catch (err) {
    adminMetricsLastError = { at: Date.now(), message: err?.message || String(err) };
    return res.json({
      ok: false,
      latency_ms: null,
      error: err?.message || String(err),
      last_success_at: adminMetricsLastSuccessAt,
      last_error_at: adminMetricsLastError.at
    });
  }
});

app.get('/usage/runtime', requireAuth, async (req, res) => {
  const plan = await getUserPlan(req.user.userId);
  const month = currentMonthKey();
  const environments = ['development', 'testing', 'production'];
  const usage = {};
  for (const env of environments) {
    const usedMs = await getRuntimeUsageMs(req.user.userId, env);
    const limitMs = runtimeQuotaMs(plan.name, env);
    const usedHours = roundHours(usedMs / 36e5);
    const limitHours = limitMs ? roundHours(limitMs / 36e5) : null;
    const percent = limitMs
      ? Math.min(100, Math.round((usedMs / limitMs) * 1000) / 10)
      : null;
    usage[env] = {
      used_ms: usedMs,
      limit_ms: limitMs,
      used_hours: usedHours,
      limit_hours: limitHours,
      percent
    };
  }
  res.json({ month, plan: plan.name, usage });
});

app.post('/projects', requireAuth, async (req, res) => {
  const { name, stackType, interfaces, mobileStackType } = req.body || {};
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'name required' });
  const plan = await getUserPlan(req.user.userId);
  const limitHit = await enforceProjectLimit(req.user.userId, plan);
  if (limitHit) {
    return res.status(403).json({
      error: 'plan_project_limit',
      plan: plan.name,
      limit: plan.maxProjects,
      count: limitHit.count
    });
  }
  const allowedStacks = new Set(['web', 'expo', 'rn_cli']);
  const nextStack = allowedStacks.has(stackType) ? stackType : 'web';
  const requestedInterfaces = Array.isArray(interfaces) ? interfaces : [];
  const webEnabled = requestedInterfaces.includes('web');
  const mobileEnabled = requestedInterfaces.includes('mobile');
  const allowMobileStacks = new Set(['expo', 'rn_cli']);
  const nextMobileStack = allowMobileStacks.has(mobileStackType) ? mobileStackType : 'expo';
  const interfaceWeb = webEnabled || (!webEnabled && !mobileEnabled);
  const interfaceMobile = mobileEnabled;
  if (interfaceMobile && !planAllowsMobile(plan)) {
    return res.status(403).json({ error: 'plan_mobile_not_allowed', plan: plan.name });
  }
  const existing = await query('select 1 from projects where lower(name) = lower($1)', [trimmedName]);
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: 'project name already exists' });
  }
  const shortId = Math.random().toString(36).slice(2, 8);
  const projectSlug = hostProjectName(trimmedName);
  const result = await query(
    `insert into projects (owner_id, name, short_id, project_slug, stack_type, interface_web, interface_mobile, mobile_stack_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [req.user.userId, trimmedName, shortId, projectSlug, nextStack, interfaceWeb, interfaceMobile, nextMobileStack]
  );
  await taskQueue.add('init-project', { projectId: result.rows[0].id });
  res.json(result.rows[0]);
});

app.put('/projects/:projectId', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'name required' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const plan = await getUserPlan(req.user.userId);
  const existing = await query(
    'select 1 from projects where lower(name) = lower($1) and id <> $2',
    [trimmedName, req.params.projectId]
  );
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: 'project name already exists' });
  }
  const projectSlug = hostProjectName(trimmedName);
  const result = await query(
    'update projects set name = $1, project_slug = $2 where id = $3 returning *',
    [trimmedName, projectSlug, req.params.projectId]
  );
  // If the project is currently deployed in any environment, redeploy to update hostname routing.
  const envRes = await query(
    'select name, deployed_commit from environments where project_id = $1',
    [req.params.projectId]
  );
  for (const env of envRes.rows) {
    if (!env.deployed_commit) continue;
    if (!planAllowsEnv(plan, env.name)) continue;
    await taskQueue.add('deploy-commit', {
      projectId: req.params.projectId,
      environment: env.name,
      commitHash: env.deployed_commit
    });
  }
  res.json(result.rows[0]);
});

app.put('/projects/:projectId/stack', requireAuth, async (req, res) => {
  const { stackType } = req.body || {};
  const allowedStacks = new Set(['web', 'expo', 'rn_cli']);
  if (!allowedStacks.has(stackType)) {
    return res.status(400).json({ error: 'invalid stack type' });
  }
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query(
    'update projects set stack_type = $1 where id = $2 returning *',
    [stackType, req.params.projectId]
  );
  res.json(result.rows[0]);
});

app.put('/projects/:projectId/interfaces', requireAuth, async (req, res) => {
  const { interfaces, mobileStackType } = req.body || {};
  const requestedInterfaces = Array.isArray(interfaces) ? interfaces : [];
  const webEnabled = requestedInterfaces.includes('web');
  const mobileEnabled = requestedInterfaces.includes('mobile');
  const allowMobileStacks = new Set(['expo', 'rn_cli']);
  const nextMobileStack = allowMobileStacks.has(mobileStackType) ? mobileStackType : 'expo';
  const interfaceWeb = webEnabled || (!webEnabled && !mobileEnabled);
  const interfaceMobile = mobileEnabled;
  const plan = await getUserPlan(req.user.userId);
  if (interfaceMobile && !planAllowsMobile(plan)) {
    return res.status(403).json({ error: 'plan_mobile_not_allowed', plan: plan.name });
  }
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query(
    'update projects set interface_web = $1, interface_mobile = $2, mobile_stack_type = $3 where id = $4 returning *',
    [interfaceWeb, interfaceMobile, nextMobileStack, req.params.projectId]
  );
  res.json(result.rows[0]);
});

app.get('/projects', requireAuth, async (req, res) => {
  const result = await query(
    `select id, owner_id, name, short_id, created_at, snapshot_status,
            project_slug, codex_thread_id, stack_type,
            interface_web, interface_mobile, mobile_stack_type
     from projects
     where owner_id = $1
     order by created_at desc`,
    [req.user.userId]
  );
  const projects = result.rows;
  const ids = projects.map((p) => p.id);
  if (ids.length === 0) return res.json([]);
  const envMap = await loadEnvironmentStatusMap(ids);
  res.json(projects.map((p) => ({ ...p, environments: envMap[p.id] || {} })));
});

app.delete('/projects/:projectId', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  await taskQueue.add('delete-project', { projectId: req.params.projectId });
  res.json({ ok: true });
});

app.post('/projects/:projectId/repo-upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const filename = (req.file.originalname || '').toLowerCase();
  const ext =
    filename.endsWith('.bundle') ? '.bundle'
    : filename.endsWith('.gitbundle') ? '.bundle'
    : filename.endsWith('.zip') ? '.zip'
    : (filename.endsWith('.tar.gz') || filename.endsWith('.tgz')) ? '.tar.gz'
    : (filename.endsWith('.tar') ? '.tar' : '');
  if (!ext) return res.status(400).json({ error: 'invalid file type' });

  const projectRes = await query(
    'select id from projects where id = $1 and owner_id = $2',
    [req.params.projectId, req.user.userId]
  );
  if (projectRes.rowCount === 0) return res.status(404).json({ error: 'project not found' });

  let extractDir;
  try {
    let repoPath = '';
    if (ext === '.bundle') {
      const loaded = await loadRepoFromBundleBuffer(req.file.buffer);
      extractDir = loaded.tempDir;
      repoPath = loaded.repoPath;
    } else {
      extractDir = await extractArchive(req.file.buffer, ext);
      repoPath = await detectRepoRoot(extractDir);
    }
    await ensureGitRepo(repoPath);
    await validateRepo(repoPath);

    const tasksRes = await query(
      `select * from tasks
       where project_id = $1
       order by created_at asc`,
      [req.params.projectId]
    );
    const sessionsRes = await query(
      `select * from sessions
       where project_id = $1
       order by created_at asc`,
      [req.params.projectId]
    );
    const tasks = tasksRes.rows;
    const sessions = sessionsRes.rows;
    const confirmDropTasks = String(req.body?.confirmDropTasks || '').toLowerCase() === 'true';
    const sessionMessage = String(req.body?.sessionMessage || '').trim();

    const shouldSync = tasks.length > 0 || sessions.length > 0;
    let transactionStarted = false;

    if (shouldSync) {
      const orderedTasks = [...tasks].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const firstIncompleteIndex = orderedTasks.findIndex(
        (task) => task.status !== 'completed' || !task.commit_hash
      );
      let incompleteTasks = [];
      if (firstIncompleteIndex !== -1) {
        const tail = orderedTasks.slice(firstIncompleteIndex);
        const hasCompletedAfter = tail.some((task) => task.status === 'completed' && task.commit_hash);
        if (hasCompletedAfter) {
          return res.status(400).json({ error: 'Upload rejected: task history is non-linear.' });
        }
        incompleteTasks = tail;
      }

      const completedTasks = orderedTasks.filter((task) => task.status === 'completed' && task.commit_hash);
      const stackTasks = completedTasks.filter((task) => !task.session_id);
      const stackHashes = stackTasks.map((task) => task.commit_hash);

      const aiExists = await branchExists(repoPath, 'ai-task');
      const aiUnique = aiExists
        ? await listCommits(['rev-list', '--reverse', 'ai-task', '--not', 'main'], repoPath)
        : [];

      const minLen = Math.min(stackHashes.length, aiUnique.length);
      for (let i = 0; i < minLen; i += 1) {
        if (stackHashes[i] !== aiUnique[i]) {
          return res.status(400).json({
            error: 'Upload rejected: task stack does not match ai-task history.'
          });
        }
      }

      let missingTasks = [];
      if (aiUnique.length < stackHashes.length) {
        missingTasks = stackTasks.slice(aiUnique.length);
      }
      const missingTaskMap = new Map(missingTasks.map((task) => [task.id, task]));
      for (const task of incompleteTasks) {
        if (!missingTaskMap.has(task.id)) missingTaskMap.set(task.id, task);
      }
      missingTasks = Array.from(missingTaskMap.values());

      const extraAiCommits = aiUnique.length > stackHashes.length
        ? aiUnique.slice(stackHashes.length)
        : [];

      const sessionCommits = sessions
        .filter((session) => session.merge_commit)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((session) => session.merge_commit);
      if (sessionCommits.length > 0) {
        const mainFirstParent = await listCommits(
          ['rev-list', '--first-parent', '--reverse', 'main'],
          repoPath
        );
        let lastIdx = -1;
        for (const commit of sessionCommits) {
          const idx = mainFirstParent.indexOf(commit);
          if (idx === -1 || idx <= lastIdx) {
            return res.status(400).json({
              error: 'Upload rejected: saved session history does not match main.'
            });
          }
          lastIdx = idx;
        }
      }

      let mainExtra = [];
      if (sessionCommits.length > 0) {
        const last = sessionCommits[sessionCommits.length - 1];
        mainExtra = await listCommits(['rev-list', '--reverse', `${last}..main`], repoPath);
      } else {
        mainExtra = await listCommits(['rev-list', '--reverse', 'main'], repoPath);
      }
      const needsSessionMessage = mainExtra.length > 0;

      const requires = {};
      if (missingTasks.length > 0 && !confirmDropTasks) {
        requires.dropTasks = {
          count: missingTasks.length,
          ids: missingTasks.map((task) => task.id)
        };
      }
      if (needsSessionMessage && !sessionMessage) {
        requires.sessionMessage = true;
      }
      if (Object.keys(requires).length > 0) {
        return res.status(409).json({ error: 'upload_requires_confirmation', requires });
      }

      if (needsSessionMessage) {
        await runGit(['checkout', 'main'], repoPath);
        await runGit(['config', 'user.name', AUTHOR_NAME], repoPath);
        await runGit(['config', 'user.email', AUTHOR_EMAIL], repoPath);
        await runGit(['commit', '--allow-empty', '-m', sessionMessage], repoPath);
      }

      await query('begin');
      transactionStarted = true;
      try {
        if (missingTasks.length > 0) {
          await query(
            'delete from tasks where id = any($1)',
            [missingTasks.map((task) => task.id)]
          );
        }

        if (extraAiCommits.length > 0) {
          for (const hash of extraAiCommits) {
            const prompt = await commitMessage(repoPath, hash);
            const timestamp = await commitTime(repoPath, hash);
            await query(
              `insert into tasks (project_id, environment, prompt, status, codex_output, commit_hash, created_at, completed_at)
               values ($1, 'development', $2, 'completed', $3, $4, $5, $5)`,
              [req.params.projectId, prompt, 'User uploaded changes', hash, timestamp]
            );
          }
        }

        if (needsSessionMessage) {
          const mergeHash = await gitOutput(['rev-parse', 'HEAD'], repoPath);
          await query(
            `insert into sessions (project_id, message, merge_commit)
             values ($1, $2, $3)`,
            [req.params.projectId, sessionMessage, mergeHash]
          );
        }
      } catch (err) {
        await query('rollback');
        transactionStarted = false;
        throw err;
      }
    }

    try {
      const repoBundle = await bundleRepo(repoPath);
      await query(
        `update projects
            set repo_bundle_blob = $1,
                repo_bundle_updated_at = now(),
                snapshot_blob = null,
                snapshot_status = $2
          where id = $3`,
        [repoBundle, 'ready', req.params.projectId]
      );
      await query(
        `update project_workspaces
           set state = 'stale',
               preview_mode = 'verified',
               workspace_dirty = true,
               last_error = 'Workspace reset required after repository upload',
               updated_at = now()
         where project_id = $1
           and environment = 'development'`,
        [req.params.projectId]
      );
      if (transactionStarted) {
        await query('commit');
        transactionStarted = false;
      }
    } catch (err) {
      if (transactionStarted) {
        await query('rollback');
        transactionStarted = false;
      }
      throw err;
    }
    await taskQueue.add('reset-workspace', {
      projectId: req.params.projectId,
      environment: 'development'
    });
    res.json({ ok: true });
  } finally {
    await removeTempDir(extractDir);
  }
});

app.get('/projects/:projectId/repo-download', requireAuth, async (req, res) => {
  const projectRes = await query(
    `select id, name, repo_bundle_blob, snapshot_blob
       from projects
      where id = $1 and owner_id = $2`,
    [req.params.projectId, req.user.userId]
  );
  if (projectRes.rowCount === 0) return res.status(404).json({ error: 'project not found' });
  const project = projectRes.rows[0];
  if (project.repo_bundle_blob) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=\"${project.name}.bundle\"`);
    return res.send(project.repo_bundle_blob);
  }
  if (!project.snapshot_blob) return res.status(404).json({ error: 'repo missing' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename=\"${project.name}.tar.gz\"`);
  res.send(project.snapshot_blob);
});

app.get('/projects/:projectId/webhook', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query('select deploy_webhook_url from projects where id = $1', [req.params.projectId]);
  res.json({ url: result.rows[0]?.deploy_webhook_url || '' });
});

app.put('/projects/:projectId/webhook', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const url = String(req.body?.url || '').trim();
  if (url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'invalid_webhook_url' });
      }
    } catch {
      return res.status(400).json({ error: 'invalid_webhook_url' });
    }
  }
  await query('update projects set deploy_webhook_url = $1 where id = $2', [url || null, req.params.projectId]);
  res.json({ ok: true, url });
});

app.post('/projects/:projectId/tasks', requireAuth, async (req, res) => {
  const { prompt, environment } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const env = environment || 'development';
  if (env !== 'development') {
    return res.status(400).json({ error: 'tasks can only be created in development' });
  }
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const inflight = await query(
    `select 1 from tasks
     where project_id = $1 and environment = $2 and status in ('queued', 'running')
     limit 1`,
    [req.params.projectId, env]
  );
  if (inflight.rowCount > 0) {
    return res.status(409).json({ error: 'task already in progress' });
  }
  if (!(await ensureRuntimeQuota(req, res, env))) return;
  await cancelSupersededDevelopmentWork(
    req.params.projectId,
    '\n\n[system] Cancel requested because a newer development task was submitted.\n'
  );
  const result = await query(
    `insert into tasks (project_id, environment, prompt, status)
     values ($1, $2, $3, 'queued')
     returning *`,
    [req.params.projectId, env, prompt]
  );
  await taskQueue.add('codex-task', { taskId: result.rows[0].id });
  res.json(result.rows[0]);
});

app.get('/projects/:projectId/tasks', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query(
    `select * from tasks
     where project_id = $1
     order by created_at desc`,
    [req.params.projectId]
  );
  res.json(result.rows);
});

function normalizeEnv(value) {
  const env = (value || '').toLowerCase();
  if (!['development', 'testing', 'production'].includes(env)) return null;
  return env;
}

async function ensurePlanEnvAllowed(req, res, env) {
  const plan = await getUserPlan(req.user.userId);
  if (!planAllowsEnv(plan, env)) {
    res.status(403).json({ error: 'plan_env_not_allowed', plan: plan.name, environment: env });
    return null;
  }
  return plan;
}

async function ensureProjectOwner(projectId, userId) {
  const result = await query(
    'select id from projects where id = $1 and owner_id = $2',
    [projectId, userId]
  );
  return result.rowCount > 0;
}

async function cancelLatestBuild(projectId, environment, reason) {
  const buildRes = await query(
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
  await query(
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
    await job.remove();
    removed += 1;
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

function workspaceNames(projectId) {
  const base = `vibes-workspace-${projectId}`;
  return {
    pvcName: `${base}-pvc`,
    podName: base,
    serviceName: base
  };
}

function normalizeDevelopmentMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['preview', 'workspace'].includes(mode)) return 'workspace';
  if (['full_build', 'full-build', 'verified'].includes(mode)) return 'verified';
  return null;
}

async function isVerifiedOnlyDeploysEnabled() {
  const result = await query('select value from settings where key = $1', ['verified_only_deploys']);
  const raw = String(result.rows[0]?.value || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

async function loadDevelopmentWorkspace(projectId) {
  const result = await query(
    `select *
       from project_workspaces
      where project_id = $1
        and environment = 'development'`,
    [projectId]
  );
  return result.rows[0] || null;
}

async function upsertDevelopmentSelection(projectId, patch = {}) {
  const existing = await loadDevelopmentWorkspace(projectId);
  const names = workspaceNames(projectId);
  const selectedMode =
    patch.selected_mode !== undefined
      ? patch.selected_mode
      : (existing?.selected_mode || existing?.preview_mode || 'verified');
  const selectedTaskId =
    Object.prototype.hasOwnProperty.call(patch, 'selected_task_id')
      ? patch.selected_task_id
      : (existing?.selected_task_id || null);
  const selectedCommitSha =
    Object.prototype.hasOwnProperty.call(patch, 'selected_commit_sha')
      ? patch.selected_commit_sha
      : (existing?.selected_commit_sha || null);
  await query(
    `insert into project_workspaces (
       project_id,
       environment,
       pvc_name,
       workspace_pod_name,
       service_name,
       state,
       preview_mode,
       selected_mode,
       selected_task_id,
       selected_commit_sha
     ) values (
       $1,
       'development',
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9
     )
     on conflict (project_id, environment)
     do update set
       selected_mode = excluded.selected_mode,
       selected_task_id = excluded.selected_task_id,
       selected_commit_sha = excluded.selected_commit_sha,
       updated_at = now()`,
    [
      projectId,
      existing?.pvc_name || names.pvcName,
      existing?.workspace_pod_name || names.podName,
      existing?.service_name || names.serviceName,
      existing?.state || 'sleeping',
      existing?.preview_mode || 'verified',
      selectedMode,
      selectedTaskId,
      selectedCommitSha
    ]
  );
}

async function loadEnvironmentStatusMap(projectIds) {
  if (!projectIds || projectIds.length === 0) return {};
  const envRes = await query(
    `select e.project_id,
            e.name,
            e.deployed_commit,
            e.build_status,
            e.updated_at,
            w.preview_mode,
            w.state as workspace_state,
            w.current_commit_sha as commit_sha,
            w.last_verified_commit_sha as verified_commit_sha,
            w.selected_mode,
            w.selected_task_id,
            w.selected_commit_sha,
            w.live_task_id,
            w.live_commit_sha,
            w.full_build_commit_sha,
            w.full_build_built_at,
            w.workspace_dirty,
            w.last_preview_heartbeat_at
       from environments e
       left join project_workspaces w
         on w.project_id = e.project_id
        and w.environment = e.name
      where e.project_id = any($1)`,
    [projectIds]
  );
  const envMap = {};
  for (const row of envRes.rows) {
    envMap[row.project_id] = envMap[row.project_id] || {};
    envMap[row.project_id][row.name] = {
      deployed_commit: row.deployed_commit,
      build_status: row.build_status,
      updated_at: row.updated_at,
      preview_mode: row.preview_mode || 'verified',
      workspace_state: row.workspace_state || 'sleeping',
      commit_sha: row.commit_sha || row.deployed_commit,
      verified_commit_sha: row.verified_commit_sha || row.deployed_commit,
      selected_mode: row.selected_mode || row.preview_mode || 'verified',
      selected_task_id: row.selected_task_id || null,
      selected_commit_sha: row.selected_commit_sha || row.commit_sha || row.deployed_commit || null,
      live_task_id: row.live_task_id || null,
      live_commit_sha: row.live_commit_sha || null,
      full_build_commit_sha: row.full_build_commit_sha || row.verified_commit_sha || row.deployed_commit || null,
      full_build_built_at: row.full_build_built_at || null,
      workspace_dirty: row.workspace_dirty ?? false,
      last_preview_heartbeat_at: row.last_preview_heartbeat_at || null
    };
  }
  return envMap;
}

app.get('/projects/:projectId/env/:environment', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const result = await query(
    `select env_vars from environments
     where project_id = $1 and name = $2`,
    [req.params.projectId, env]
  );
  res.json({ envVars: result.rows[0]?.env_vars || {} });
});

app.put('/projects/:projectId/env/:environment', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const envVars = req.body?.envVars || {};
  if (typeof envVars !== 'object' || Array.isArray(envVars)) {
    return res.status(400).json({ error: 'envVars must be an object' });
  }
  await query(
    `insert into environments (project_id, name, env_vars)
     values ($1, $2, $3)
     on conflict (project_id, name)
     do update set env_vars = excluded.env_vars`,
    [req.params.projectId, env, envVars]
  );
  res.json({ ok: true });
});

app.post('/projects/:projectId/env/:environment/empty-db', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  await taskQueue.add('empty-db', { projectId: req.params.projectId, environment: env });
  await writeDatabaseAudit(req, {
    projectId: req.params.projectId,
    environment: env,
    action: 'empty_database_requested',
    success: true
  }).catch((err) => {
    console.warn('Database audit write failed', err?.message || err);
  });
  res.json({ ok: true });
});

async function withDatabaseRoute(req, res, env, action, work) {
  const startedAt = Date.now();
  try {
    const result = await work();
    await writeDatabaseAudit(req, {
      projectId: req.params.projectId,
      environment: env,
      action,
      schemaName: result?.audit?.schemaName || null,
      objectName: result?.audit?.objectName || null,
      queryText: result?.audit?.queryText || '',
      success: true,
      durationMs: Date.now() - startedAt,
      rowCount: result?.audit?.rowCount ?? null
    }).catch((err) => {
      console.warn('Database audit write failed', err?.message || err);
    });
    return res.json(result?.body ?? result);
  } catch (err) {
    await writeDatabaseAudit(req, {
      projectId: req.params.projectId,
      environment: env,
      action,
      schemaName: req.params.schema || null,
      objectName: req.params.object || null,
      queryText: req.body?.sql || '',
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: err.code || 'database_request_failed'
    }).catch((auditErr) => {
      console.warn('Database audit write failed', auditErr?.message || auditErr);
    });
    const payload = databaseErrorPayload(err);
    return res.status(err.status || 500).json({
      error: payload.code,
      message: payload.message,
      retryable: payload.retryable,
      details: payload.details
    });
  }
}

app.get('/projects/:projectId/database/:environment/catalog', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  return withDatabaseRoute(req, res, env, 'catalog_view', async () => {
    const body = await getDatabaseCatalog(req.params.projectId, env);
    return { body };
  });
});

app.get('/projects/:projectId/database/:environment/objects/:schema/:object', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  return withDatabaseRoute(req, res, env, 'object_view', async () => {
    const body = await getDatabaseObjectDetails(req.params.projectId, env, req.params.schema, req.params.object);
    return {
      body,
      audit: {
        schemaName: req.params.schema,
        objectName: req.params.object
      }
    };
  });
});

app.get('/projects/:projectId/database/:environment/objects/:schema/:object/rows', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  return withDatabaseRoute(req, res, env, 'rows_browse', async () => {
    const body = await browseDatabaseRows(req.params.projectId, env, req.params.schema, req.params.object, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      sortColumn: req.query.sortColumn,
      sortDirection: req.query.sortDirection,
      filterColumn: req.query.filterColumn,
      filterValue: req.query.filterValue
    });
    return {
      body,
      audit: {
        schemaName: req.params.schema,
        objectName: req.params.object,
        rowCount: Array.isArray(body.rows) ? body.rows.length : null
      }
    };
  });
});

app.post('/projects/:projectId/database/:environment/query', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  return withDatabaseRoute(req, res, env, 'query_execute', async () => {
    const sql = String(req.body?.sql || '');
    const body = await executeDatabaseQuery(req.params.projectId, env, sql);
    return {
      body,
      audit: {
        queryText: sql,
        rowCount: body.rowCount
      }
    };
  });
});

app.get('/projects/:projectId/database/:environment/history', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.params.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  try {
    const entries = await loadDatabaseHistory(req.params.projectId, env, req.query.limit);
    return res.json({ entries });
  } catch (err) {
    const payload = databaseErrorPayload(err);
    return res.status(err.status || 500).json({
      error: payload.code,
      message: payload.message,
      retryable: payload.retryable,
      details: payload.details
    });
  }
});

app.post('/projects/:projectId/deploy', requireAuth, async (req, res) => {
  const { commitHash, environment } = req.body || {};
  const env = normalizeEnv(environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  if (!commitHash) return res.status(400).json({ error: 'commitHash required' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  if (!(await ensureBuildLimit(req, res, req.params.projectId))) return;
  if (!(await ensureDbStorageLimit(req, res, req.params.projectId, env))) return;
  if (!(await ensureBandwidthLimit(req, res, req.params.projectId))) return;
  if (!(await ensureRuntimeQuota(req, res, env))) return;
  const buildingRes = await query(
    `select id
     from builds
     where project_id = $1
       and environment = $2
       and status = 'building'
       and coalesce(ref_commit, '') = $3
     order by created_at desc
     limit 1`,
    [req.params.projectId, env, commitHash]
  );
  if (buildingRes.rowCount > 0) {
    return res.json({ ok: true, status: 'already_building', buildId: buildingRes.rows[0].id });
  }
  const envStateRes = await query(
    `select e.build_status,
            e.deployed_commit,
            w.preview_mode,
            w.state as workspace_state,
            w.current_commit_sha
     from environments e
     left join project_workspaces w
       on w.project_id = e.project_id
      and w.environment = 'development'
     where e.project_id = $1
       and e.name = $2`,
    [req.params.projectId, env]
  );
  const envState = envStateRes.rows[0] || null;
  const alreadyLiveVerified =
    envState?.build_status === 'live' &&
    envState?.deployed_commit === commitHash;
  const alreadyLiveWorkspace =
    env === 'development' &&
    envState?.build_status === 'live' &&
    envState?.preview_mode === 'workspace' &&
    envState?.workspace_state === 'ready' &&
    envState?.current_commit_sha === commitHash;
  if (alreadyLiveVerified || alreadyLiveWorkspace) {
    return res.json({ ok: true, status: 'already_live' });
  }
  await taskQueue.add('deploy-commit', { projectId: req.params.projectId, environment: env, commitHash });
  res.json({ ok: true, status: 'queued' });
});

app.post('/projects/:projectId/development/resume-preview', requireAuth, async (req, res) => {
  const env = 'development';
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  if (!(await ensureRuntimeQuota(req, res, env))) return;
  const policyRes = await query('select value from settings where key = $1', ['verified_only_deploys']);
  const rawPolicy = String(policyRes.rows[0]?.value || '').trim().toLowerCase();
  const verifiedOnly = rawPolicy === 'true' || rawPolicy === '1' || rawPolicy === 'yes' || rawPolicy === 'on';
  if (verifiedOnly) {
    return res.status(409).json({ error: 'preview_disabled', message: 'Development preview is disabled by verified-only deploys.' });
  }
  const envStateRes = await query(
    `select e.build_status,
            w.preview_mode,
            w.state as workspace_state,
            w.current_commit_sha
     from environments e
     left join project_workspaces w
       on w.project_id = e.project_id
      and w.environment = 'development'
     where e.project_id = $1
       and e.name = $2`,
    [req.params.projectId, env]
  );
  const envState = envStateRes.rows[0] || null;
  if (
    envState?.build_status === 'live' &&
    envState?.preview_mode === 'workspace' &&
    envState?.workspace_state === 'ready'
  ) {
    return res.json({ ok: true, status: 'already_live', commitHash: envState.current_commit_sha || null });
  }
  const resumeJobId = `resume-development-preview-${req.params.projectId}`;
  const existingResumeJob = await taskQueue.getJob(resumeJobId);
  if (existingResumeJob) {
    const state = await existingResumeJob.getState();
    if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) {
      return res.json({ ok: true, status: 'already_starting' });
    }
    try {
      await existingResumeJob.remove();
    } catch {}
  }
  await taskQueue.add(
    'resume-development-preview',
    { projectId: req.params.projectId },
    { jobId: resumeJobId, removeOnComplete: true, removeOnFail: 50 }
  );
  res.json({ ok: true, status: 'queued' });
});

app.put('/projects/:projectId/development/selection', requireAuth, async (req, res) => {
  const env = 'development';
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const mode = normalizeDevelopmentMode(req.body?.mode);
  if (!mode) return res.status(400).json({ error: 'invalid_mode' });
  if (mode === 'workspace' && await isVerifiedOnlyDeploysEnabled()) {
    return res.status(409).json({
      error: 'preview_disabled',
      message: 'Development preview is disabled by verified-only deploys.'
    });
  }
  let taskId = Object.prototype.hasOwnProperty.call(req.body || {}, 'taskId')
    ? (req.body?.taskId || null)
    : undefined;
  let commitHash = Object.prototype.hasOwnProperty.call(req.body || {}, 'commitHash')
    ? String(req.body?.commitHash || '').trim() || null
    : undefined;
  if (taskId) {
    const taskRes = await query(
      `select id, commit_hash
         from tasks
        where id = $1
          and project_id = $2`,
      [taskId, req.params.projectId]
    );
    if (taskRes.rowCount === 0) {
      return res.status(404).json({ error: 'task_not_found' });
    }
    if (!taskRes.rows[0].commit_hash) {
      return res.status(409).json({ error: 'task_commit_unavailable' });
    }
    commitHash = commitHash || taskRes.rows[0].commit_hash;
  }
  await upsertDevelopmentSelection(req.params.projectId, {
    selected_mode: mode,
    ...(taskId !== undefined ? { selected_task_id: taskId } : {}),
    ...(commitHash !== undefined ? { selected_commit_sha: commitHash } : {})
  });
  res.json({
    ok: true,
    selected_mode: mode,
    selected_task_id: taskId === undefined ? undefined : taskId,
    selected_commit_sha: commitHash === undefined ? undefined : commitHash
  });
});

app.post('/projects/:projectId/development/wake', requireAuth, async (req, res) => {
  const env = 'development';
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  if (!(await ensureRuntimeQuota(req, res, env))) return;

  const modeInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'mode')
    ? normalizeDevelopmentMode(req.body?.mode)
    : null;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'mode') && !modeInput) {
    return res.status(400).json({ error: 'invalid_mode' });
  }

  let taskId = Object.prototype.hasOwnProperty.call(req.body || {}, 'taskId')
    ? (req.body?.taskId || null)
    : undefined;
  let commitHash = Object.prototype.hasOwnProperty.call(req.body || {}, 'commitHash')
    ? String(req.body?.commitHash || '').trim() || null
    : undefined;
  if (taskId) {
    const taskRes = await query(
      `select id, commit_hash
         from tasks
        where id = $1
          and project_id = $2`,
      [taskId, req.params.projectId]
    );
    if (taskRes.rowCount === 0) {
      return res.status(404).json({ error: 'task_not_found' });
    }
    if (!taskRes.rows[0].commit_hash) {
      return res.status(409).json({ error: 'task_commit_unavailable' });
    }
    commitHash = commitHash || taskRes.rows[0].commit_hash;
  }

  if (modeInput || taskId !== undefined || commitHash !== undefined) {
    await upsertDevelopmentSelection(req.params.projectId, {
      ...(modeInput ? { selected_mode: modeInput } : {}),
      ...(taskId !== undefined ? { selected_task_id: taskId } : {}),
      ...(commitHash !== undefined ? { selected_commit_sha: commitHash } : {})
    });
  }

  const workspace = await loadDevelopmentWorkspace(req.params.projectId);
  const targetMode = workspace?.selected_mode || modeInput || workspace?.preview_mode || 'verified';
  if (normalizeDevelopmentMode(targetMode) === 'workspace' && await isVerifiedOnlyDeploysEnabled()) {
    return res.status(409).json({
      error: 'preview_disabled',
      message: 'Development preview is disabled by verified-only deploys.'
    });
  }
  const targetCommit = workspace?.selected_commit_sha || commitHash || null;
  const targetTaskId = workspace?.selected_task_id || null;
  const envStateRes = await query(
    `select e.build_status,
            w.preview_mode,
            w.live_task_id,
            w.live_commit_sha
       from environments e
       left join project_workspaces w
         on w.project_id = e.project_id
        and w.environment = 'development'
      where e.project_id = $1
        and e.name = 'development'`,
    [req.params.projectId]
  );
  const envState = envStateRes.rows[0] || null;
  if (
    envState?.build_status === 'live' &&
    envState?.preview_mode === targetMode &&
    envState?.live_commit_sha &&
    targetCommit &&
    envState.live_commit_sha === targetCommit &&
    String(envState.live_task_id || '') === String(targetTaskId || '')
  ) {
    return res.json({ ok: true, status: 'already_live', mode: targetMode, commitHash: targetCommit });
  }

  const wakeJobId = `activate-development-selection-${req.params.projectId}`;
  const existingWakeJob = await taskQueue.getJob(wakeJobId);
  if (existingWakeJob) {
    const state = await existingWakeJob.getState();
    if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) {
      return res.json({ ok: true, status: 'already_starting' });
    }
    try {
      await existingWakeJob.remove();
    } catch {}
  }

  await taskQueue.add(
    'activate-development-selection',
    {
      projectId: req.params.projectId,
      mode: targetMode,
      taskId: targetTaskId,
      commitHash: targetCommit
    },
    { jobId: wakeJobId, removeOnComplete: true, removeOnFail: 50 }
  );
  res.json({ ok: true, status: 'queued', mode: targetMode, commitHash: targetCommit });
});

app.post('/projects/:projectId/development/verify', requireAuth, async (req, res) => {
  const env = 'development';
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  if (!(await ensureBuildLimit(req, res, req.params.projectId))) return;
  if (!(await ensureDbStorageLimit(req, res, req.params.projectId, env))) return;
  if (!(await ensureBandwidthLimit(req, res, req.params.projectId))) return;
  if (!(await ensureRuntimeQuota(req, res, env))) return;
  const stateRes = await query(
    `select w.current_commit_sha,
            w.last_verified_commit_sha,
            w.workspace_dirty
     from project_workspaces w
     where w.project_id = $1
       and w.environment = 'development'`,
    [req.params.projectId]
  );
  const workspace = stateRes.rows[0] || null;
  const commitHash = workspace?.current_commit_sha || null;
  if (!commitHash) {
    return res.status(409).json({ error: 'workspace_commit_unavailable' });
  }
  if (
    workspace?.last_verified_commit_sha === commitHash &&
    workspace?.workspace_dirty === false
  ) {
    return res.json({ ok: true, status: 'already_verified', commitHash });
  }
  const buildingRes = await query(
    `select id
     from builds
     where project_id = $1
       and environment = $2
       and status = 'building'
       and coalesce(ref_commit, '') = $3
     order by created_at desc
     limit 1`,
    [req.params.projectId, env, commitHash]
  );
  if (buildingRes.rowCount > 0) {
    return res.json({ ok: true, status: 'already_building', buildId: buildingRes.rows[0].id, commitHash });
  }
  await removeQueuedDevelopmentJobs(req.params.projectId, new Set(['verify-development-workspace']));
  await taskQueue.add(
    'verify-development-preview',
    { projectId: req.params.projectId },
    { jobId: `verify-development-preview-${req.params.projectId}-${commitHash}` }
  );
  res.json({ ok: true, status: 'queued', commitHash });
});

app.post('/projects/:projectId/builds/cancel', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.body?.environment || req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  let buildId = null;
  let removed = 0;
  try {
    if (env === 'development') {
      ({ buildId, removed } = await cancelSupersededDevelopmentWork(
        req.params.projectId,
        '\n\n[system] Cancel requested by user.\n'
      ));
    } else {
      buildId = await cancelLatestBuild(req.params.projectId, env, '\n\n[system] Cancel requested by user.\n');
      removed = await removeQueuedDevelopmentJobs(
        req.params.projectId,
        new Set(['deploy-commit']),
        env
      );
    }
    if (!buildId && removed === 0) {
      return res.json({ ok: true, status: 'noop' });
    }
  } catch (err) {
    console.warn('Failed to remove queued deploy jobs', err?.message || err);
  }
  res.json({ ok: true, buildId });
});

app.post('/projects/:projectId/stop', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.body?.environment || req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  if (env === 'development') {
    await cancelSupersededDevelopmentWork(
      req.params.projectId,
      '\n\n[system] Cancel requested because the development environment was stopped.\n'
    );
  } else {
    await cancelLatestBuild(
      req.params.projectId,
      env,
      '\n\n[system] Cancel requested because the environment was stopped.\n'
    );
  }
  await taskQueue.add('stop-environment', { projectId: req.params.projectId, environment: env });
  res.json({ ok: true });
});

app.get('/projects/:projectId/builds/latest', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const result = await query(
    `select * from builds
     where project_id = $1 and environment = $2
     order by created_at desc
     limit 1`,
    [req.params.projectId, env]
  );
  res.json(result.rows[0] || null);
});

app.get('/projects/:projectId/builds/log', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const commit = String(req.query.commitHash || req.query.commit || '').trim();
  const status = String(req.query.status || 'failed').trim() || 'failed';
  const lines = Math.min(Number(req.query.lines || 200), 2000);
  const params = [req.params.projectId, env];
  let where = `project_id = $1 and environment = $2`;
  if (status) {
    params.push(status);
    where += ` and status = $${params.length}`;
  }
  if (commit) {
    params.push(commit);
    where += ` and ref_commit = $${params.length}`;
  }
  const result = await query(
    `select * from builds
     where ${where}
     order by created_at desc
     limit 1`,
    params
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'build_not_found' });
  const row = result.rows[0];
  let log = row.build_log || '';
  let truncated = false;
  if (log && lines) {
    const parts = log.split('\n');
    if (parts.length > lines) {
      log = parts.slice(-lines).join('\n');
      truncated = true;
    }
  }
  res.json({ ...row, build_log: log, truncated });
});

app.get('/projects/:projectId/builds/summary', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query(
    `select distinct on (environment) environment, ref_commit, created_at, updated_at
     from builds
     where project_id = $1 and status = 'live'
     order by environment, updated_at desc`,
    [req.params.projectId]
  );
  const environments = {};
  for (const row of result.rows) {
    const createdAt = row.created_at ? new Date(row.created_at).getTime() : null;
    const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : null;
    let durationMs = null;
    if (Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt >= createdAt) {
      durationMs = updatedAt - createdAt;
    }
    environments[row.environment] = {
      ref_commit: row.ref_commit,
      created_at: row.created_at,
      updated_at: row.updated_at,
      duration_ms: durationMs
    };
  }
  res.json({ environments });
});

function logCommandForEnv() {
  if ((process.env.PLATFORM_ENV || 'local') === 'local') {
    return process.env.DEV_LOG_COMMAND;
  }
  return process.env.PROD_LOG_COMMAND;
}

function runtimeNamespaceForEnv(env) {
  const normalized = String(env || '').trim().toLowerCase();
  if (normalized === 'development' || normalized === 'dev') return RUNTIME_NAMESPACE_DEVELOPMENT;
  if (normalized === 'testing' || normalized === 'test') return RUNTIME_NAMESPACE_TESTING;
  if (normalized === 'production' || normalized === 'prod') return RUNTIME_NAMESPACE_PRODUCTION;
  return `vibes-${normalized || 'development'}`;
}

function summarizePodStatus(pod) {
  const lines = [];
  const name = pod?.metadata?.name || 'unknown';
  const phase = pod?.status?.phase || 'unknown';
  const reason = pod?.status?.reason;
  const message = pod?.status?.message;
  lines.push(`Pod ${name}: ${phase}${reason ? ` (${reason})` : ''}`);
  if (message) lines.push(message);
  const statuses = [
    ...(pod?.status?.initContainerStatuses || []),
    ...(pod?.status?.containerStatuses || [])
  ];
  for (const status of statuses) {
    const cname = status?.name || 'container';
    const restartCount = Number(status?.restartCount || 0);
    if (status?.state?.waiting) {
      const waitReason = status.state.waiting.reason || 'waiting';
      const waitMsg = status.state.waiting.message || '';
      lines.push(`- ${cname}: waiting (${waitReason})${restartCount ? `, restarts ${restartCount}` : ''}`);
      if (waitMsg) lines.push(`  ${waitMsg}`);
      continue;
    }
    if (status?.state?.terminated) {
      const termReason = status.state.terminated.reason || 'terminated';
      const exitCode = status.state.terminated.exitCode;
      lines.push(`- ${cname}: terminated (${termReason}) exit ${exitCode}`);
      continue;
    }
    if (status?.state?.running) {
      const ready = status?.ready ? 'ready' : 'not ready';
      lines.push(`- ${cname}: running (${ready})${restartCount ? `, restarts ${restartCount}` : ''}`);
      const lastTerminated = status?.lastState?.terminated;
      if (lastTerminated) {
        const lastReason = lastTerminated.reason || 'terminated';
        const lastExit = Number(lastTerminated.exitCode ?? -1);
        const lastSignal = Number(lastTerminated.signal ?? 0);
        const lastMsg = String(lastTerminated.message || '').trim();
        const signalSuffix = lastSignal > 0 ? ` signal ${lastSignal}` : '';
        lines.push(`  last termination: ${lastReason} exit ${lastExit}${signalSuffix}`);
        if (lastMsg) lines.push(`  ${lastMsg}`);
      }
      continue;
    }
  }
  return lines.join('\n');
}

async function getPodStatusSummary(namespace, appName) {
  try {
    const { stdout } = await exec('sh', ['-lc', `kubectl -n ${namespace} get pods -l app=${appName} -o json`]);
    const data = JSON.parse(stdout || '{}');
    const pods = Array.isArray(data.items) ? data.items : [];
    if (!pods.length) return 'No pods found for this app yet.';
    return pods.map((pod) => summarizePodStatus(pod)).join('\n\n');
  } catch (err) {
    return `Unable to load pod status: ${err?.message || 'unknown error'}`;
  }
}

function truthyQueryFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

async function listPodsForApp(namespace, appName) {
  const { stdout } = await exec('kubectl', ['-n', namespace, 'get', 'pods', '-l', `app=${appName}`, '-o', 'json']);
  const data = JSON.parse(stdout || '{}');
  const pods = Array.isArray(data.items) ? data.items : [];
  pods.sort((a, b) => {
    const aTime = new Date(a?.metadata?.creationTimestamp || 0).getTime() || 0;
    const bTime = new Date(b?.metadata?.creationTimestamp || 0).getTime() || 0;
    return bTime - aTime;
  });
  return pods;
}

async function collectPreviousRestartLogs(namespace, appName, lines) {
  try {
    const pods = await listPodsForApp(namespace, appName);
    if (!pods.length) return { logs: '', restartDetected: false };
    const tail = Math.max(20, Math.min(Number(lines || 200), 400));
    const sections = [];
    const maxSections = 4;
    let restartDetected = false;
    for (const pod of pods) {
      const podName = pod?.metadata?.name || '';
      if (!podName) continue;
      const statuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
      for (const status of statuses) {
        const restartCount = Number(status?.restartCount || 0);
        if (restartCount <= 0) continue;
        restartDetected = true;
        const containerName = status?.name || '';
        if (!containerName) continue;
        try {
          const { stdout, stderr } = await exec('kubectl', [
            '-n',
            namespace,
            'logs',
            podName,
            '-c',
            containerName,
            '--previous',
            `--tail=${tail}`
          ]);
          const text = `${stdout || ''}${stderr || ''}`.trim();
          if (!text) continue;
          sections.push(`[previous ${podName}/${containerName}]\n${text}`);
          if (sections.length >= maxSections) break;
        } catch {
          // best effort
        }
      }
      if (sections.length >= maxSections) break;
    }
    return { logs: sections.join('\n\n'), restartDetected };
  } catch {
    return { logs: '', restartDetected: false };
  }
}

async function getStoredRuntimeLog(projectId, environment) {
  try {
    const result = await query(
      `select latest_runtime_log, latest_runtime_log_updated_at, latest_runtime_log_attempt_id
       from environments
       where project_id = $1 and name = $2
       limit 1`,
      [projectId, environment]
    );
    if (result.rowCount === 0) return null;
    return {
      logs: result.rows[0]?.latest_runtime_log || '',
      updatedAt: result.rows[0]?.latest_runtime_log_updated_at || null,
      attemptId: result.rows[0]?.latest_runtime_log_attempt_id || null
    };
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('latest_runtime_log')) return null;
    throw err;
  }
}

function tailLogLines(text, lines) {
  const source = String(text || '');
  if (!source) return '';
  const limit = Math.max(1, Math.min(Number(lines || 200), 2000));
  const parts = source.split('\n');
  if (parts.length <= limit) return source;
  return parts.slice(-limit).join('\n');
}

app.get('/projects/:projectId/runtime-logs', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const lines = Math.min(Number(req.query.lines || 200), 2000);
  const includePrevious =
    truthyQueryFlag(req.query.includePrevious) || truthyQueryFlag(req.query.include_previous);
  const previousOnly =
    truthyQueryFlag(req.query.previousOnly) || truthyQueryFlag(req.query.previous_only);
  const canReadPrevious = (includePrevious || previousOnly) && (process.env.PLATFORM_ENV || 'local') !== 'local';
  const namespace = runtimeNamespaceForEnv(env);
  const appName = `vibes-app-${req.params.projectId}`;
  const stored = await getStoredRuntimeLog(req.params.projectId, env);
  if (stored && String(stored.logs || '').length > 0) {
    const storedTail = tailLogLines(stored.logs, lines);
    if (!canReadPrevious) {
      return res.json({
        logs: storedTail,
        source: 'stored',
        updated_at: stored.updatedAt,
        attempt_id: stored.attemptId
      });
    }
    const previous = await collectPreviousRestartLogs(namespace, appName, lines);
    const statusSummary = (previousOnly || previous.restartDetected)
      ? await getPodStatusSummary(namespace, appName)
      : '';
    if (previousOnly) {
      const sections = [previous.logs || storedTail];
      if (statusSummary) sections.push(`Pod status:\n${statusSummary}`);
      return res.json({
        logs: sections.filter(Boolean).join('\n\n'),
        source: previous.logs ? 'stored+previous' : 'stored',
        updated_at: stored.updatedAt,
        attempt_id: stored.attemptId
      });
    }
    let logs = storedTail;
    if (previous.logs) logs = `${previous.logs}\n\n${logs}`;
    if (statusSummary) logs = [logs, `Pod status:\n${statusSummary}`].filter(Boolean).join('\n\n');
    return res.json({
      logs,
      source: previous.logs ? 'stored+previous' : 'stored',
      updated_at: stored.updatedAt,
      attempt_id: stored.attemptId
    });
  }
  const cmd = logCommandForEnv(env);
  if (!cmd) {
    if (stored) {
      return res.json({
        logs: tailLogLines(stored.logs || '', lines),
        source: 'stored',
        updated_at: stored.updatedAt,
        attempt_id: stored.attemptId
      });
    }
    return res.status(400).json({ error: 'log command not configured' });
  }
  const envVars = {
    ...process.env,
    PROJECT_ID: req.params.projectId,
    PROJECT_SHORT_ID: null,
    ENVIRONMENT: env,
    LOG_LINES: String(lines),
    NAMESPACE: namespace,
    APP_NAME: appName
  };
  try {
    const shortRes = await query('select short_id from projects where id = $1', [req.params.projectId]);
    envVars.PROJECT_SHORT_ID = shortRes.rows[0]?.short_id || '';
  } catch {}
  try {
    const { stdout, stderr } = await exec('sh', ['-lc', cmd], { env: envVars });
    let logs = `${stdout || ''}${stderr || ''}`;
    let previous = { logs: '', restartDetected: false };
    let statusSummary = '';
    if (canReadPrevious) {
      previous = await collectPreviousRestartLogs(envVars.NAMESPACE, envVars.APP_NAME, lines);
      if (previousOnly || previous.restartDetected) {
        statusSummary = await getPodStatusSummary(envVars.NAMESPACE, envVars.APP_NAME);
      }
      if (previousOnly) {
        const sections = [previous.logs];
        if (statusSummary) sections.push(`Pod status:\n${statusSummary}`);
        logs = sections.filter(Boolean).join('\n\n');
      } else if (previous.logs) {
        logs = logs ? `${previous.logs}\n\n${logs}` : previous.logs;
      }
      if (!previousOnly && statusSummary) {
        logs = [logs, `Pod status:\n${statusSummary}`].filter(Boolean).join('\n\n');
      }
    }
    res.json({ logs });
  } catch (err) {
    const errOutput = `${err?.stdout || ''}${err?.stderr || ''}`.trim();
    const previous = canReadPrevious
      ? await collectPreviousRestartLogs(envVars.NAMESPACE, envVars.APP_NAME, lines)
      : { logs: '', restartDetected: false };
    const statusSummary = await getPodStatusSummary(envVars.NAMESPACE, envVars.APP_NAME);
    if (previousOnly) {
      const sections = [previous.logs];
      if (statusSummary) sections.push(`Pod status:\n${statusSummary}`);
      return res.json({ logs: sections.filter(Boolean).join('\n\n'), error: err?.message || 'log_failed' });
    }
    const details = [
      errOutput ? errOutput : `Log command failed: ${err?.message || 'unknown error'}`,
      previous.logs ? `Previous container logs:\n${previous.logs}` : '',
      statusSummary ? `Pod status:\n${statusSummary}` : ''
    ]
      .filter(Boolean)
      .join('\n\n');
    res.json({ logs: details, error: err?.message || 'log_failed' });
  }
});

app.post('/projects/:projectId/sessions', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query(
    `insert into sessions (project_id, message)
     values ($1, $2)
     returning *`,
    [req.params.projectId, message]
  );
  await taskQueue.add('save-session', { sessionId: result.rows[0].id });
  res.json(result.rows[0]);
});

app.get('/projects/:projectId/sessions', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  const result = await query(
    `select * from sessions
     where project_id = $1
     order by created_at desc`,
    [req.params.projectId]
  );
  res.json(result.rows);
});

app.delete('/projects/:projectId/tasks/latest', requireAuth, async (req, res) => {
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  await taskQueue.add('delete-latest-task', { projectId: req.params.projectId });
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: corsOptions
});

io.on('connection', (socket) => {
  const emitProjectStatus = async (projectId, target = null) => {
    const envMap = await loadEnvironmentStatusMap([projectId]);
    const environments = envMap[projectId] || {};
    if (target) {
      target.emit('projectStatus', { projectId, environments });
    } else {
      io.to(`project:${projectId}`).emit('projectStatus', { projectId, environments });
    }
  };

  socket.on('joinProject', async (projectId) => {
    if (!projectId) return;
    const prevProjectId = socket.data?.projectId;
    if (prevProjectId && prevProjectId !== projectId) {
      socket.leave(`project:${prevProjectId}`);
    }
    socket.data.projectId = projectId;
    socket.join(`project:${projectId}`);
    try {
      await emitProjectStatus(projectId, socket);
    } catch (err) {
      console.error('Failed to load project status', err);
    }
  });
  socket.on('projectEvent', ({ projectId, event, payload }) => {
    if (!projectId || !event) return;
    io.to(`project:${projectId}`).emit(event, payload);
    if (['buildUpdated', 'projectUpdated', 'workspaceUpdated'].includes(event)) {
      emitProjectStatus(projectId).catch((err) => {
        console.error('Failed to emit project status', err);
      });
    }
  });
});

if (config.runMigrations) {
  await runMigrations();
}

server.listen(config.port, () => {
  console.log(`Server listening on ${config.port}`);
});
