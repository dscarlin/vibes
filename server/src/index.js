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
import { archiveRepo, detectRepoRoot, ensureGitRepo, extractArchive, removeTempDir, validateRepo } from './repo.js';
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

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/downloads/desktop', async (req, res) => {
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

app.use('/admin/static', express.static(ADMIN_UI_DIR));
app.get(['/admin', '/admin/'], (req, res) => {
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
  const result = await query('select openai_api_key from users where id = $1', [req.user.id]);
  res.json({ enabled: true, openaiApiKey: result.rows[0]?.openai_api_key || '' });
});

app.put('/settings/demo-openai-key', requireAuth, async (req, res) => {
  const enabled = await isDemoModeEnabled();
  if (!enabled) return res.status(403).json({ error: 'demo mode disabled' });
  const nextKey = String(req.body?.openaiApiKey || '').trim();
  await query('update users set openai_api_key = $1 where id = $2', [nextKey || null, req.user.id]);
  res.json({ ok: true });
});

const authRateLimit = rateLimit({
  keyPrefix: 'auth',
  windowMs: RATE_LIMIT_AUTH_WINDOW_MS,
  max: RATE_LIMIT_AUTH_MAX
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
  res.json({ token, user });
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
      is_platform_admin: Boolean(user.is_platform_admin)
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
        let restartCount = 0;
        for (const status of statuses) {
          const reason = status.state?.waiting?.reason || '';
          if (reason === 'CrashLoopBackOff') podIssues.crash_loop += 1;
          if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') podIssues.image_pull_backoff += 1;
          if (reason === 'CrashLoopBackOff') isCrashLoop = true;
          restartCount += Number(status.restartCount || 0);
        }

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
            restarts: restartCount
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
  const envRes = await query(
    'select project_id, name, deployed_commit, build_status, updated_at from environments where project_id = any($1)',
    [ids]
  );
  const envMap = {};
  for (const row of envRes.rows) {
    envMap[row.project_id] = envMap[row.project_id] || {};
    envMap[row.project_id][row.name] = {
      deployed_commit: row.deployed_commit,
      build_status: row.build_status,
      updated_at: row.updated_at
    };
  }
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
    filename.endsWith('.zip') ? '.zip'
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
    extractDir = await extractArchive(req.file.buffer, ext);
    const repoPath = await detectRepoRoot(extractDir);
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
      const snapshot = await archiveRepo(repoPath);
      await query(
        'update projects set snapshot_blob = $1, snapshot_status = $2 where id = $3',
        [snapshot, 'ready', req.params.projectId]
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
    res.json({ ok: true });
  } finally {
    await removeTempDir(extractDir);
  }
});

app.get('/projects/:projectId/repo-download', requireAuth, async (req, res) => {
  const projectRes = await query(
    'select id, name, snapshot_blob from projects where id = $1 and owner_id = $2',
    [req.params.projectId, req.user.userId]
  );
  if (projectRes.rowCount === 0) return res.status(404).json({ error: 'project not found' });
  const project = projectRes.rows[0];
  if (!project.snapshot_blob) return res.status(404).json({ error: 'snapshot missing' });
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
  res.json({ ok: true });
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
  await taskQueue.add('deploy-commit', { projectId: req.params.projectId, environment: env, commitHash });
  res.json({ ok: true });
});

app.post('/projects/:projectId/stop', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.body?.environment || req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
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

app.get('/projects/:projectId/runtime-logs', requireAuth, async (req, res) => {
  const env = normalizeEnv(req.query.environment);
  if (!env) return res.status(400).json({ error: 'invalid environment' });
  const ok = await ensureProjectOwner(req.params.projectId, req.user.userId);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  if (!(await ensurePlanEnvAllowed(req, res, env))) return;
  const cmd = logCommandForEnv(env);
  if (!cmd) return res.status(400).json({ error: 'log command not configured' });
  const lines = Math.min(Number(req.query.lines || 200), 2000);
  const envVars = {
    ...process.env,
    PROJECT_ID: req.params.projectId,
    PROJECT_SHORT_ID: null,
    ENVIRONMENT: env,
    LOG_LINES: String(lines),
    NAMESPACE: `vibes-${env}`,
    APP_NAME: `vibes-app-${req.params.projectId}`
  };
  try {
    const shortRes = await query('select short_id from projects where id = $1', [req.params.projectId]);
    envVars.PROJECT_SHORT_ID = shortRes.rows[0]?.short_id || '';
  } catch {}
  try {
    const { stdout, stderr } = await exec('sh', ['-lc', cmd], { env: envVars });
    res.json({ logs: `${stdout || ''}${stderr || ''}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const envRes = await query(
      'select name, deployed_commit, build_status, updated_at from environments where project_id = $1',
      [projectId]
    );
    const environments = {};
    for (const row of envRes.rows) {
      environments[row.name] = {
        deployed_commit: row.deployed_commit,
        build_status: row.build_status,
        updated_at: row.updated_at
      };
    }
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
    if (event === 'buildUpdated') {
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
