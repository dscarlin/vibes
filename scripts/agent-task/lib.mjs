#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export function repoRootFrom(importMetaUrl) {
  return path.resolve(path.dirname(new URL(importMetaUrl).pathname), '..', '..');
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function shortRandom(length = 6) {
  return crypto.randomBytes(8).toString('hex').slice(0, length);
}

export function slugify(value, { maxLength = 28 } = {}) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (normalized || 'task').slice(0, maxLength).replace(/-+$/g, '') || 'task';
}

export function schemaNameFromSlug(slug) {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'task';
  return `task_${normalized}`.slice(0, 63).replace(/_+$/g, '');
}

export function projectDatabasePrefixFromSlug(slug) {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'task';
  return `vibes_task_${normalized}`.slice(0, 40).replace(/_+$/g, '');
}

export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

export function quoteIdent(identifier) {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).replace(/\\n/g, '\n');
    values[key] = value;
  }
  return values;
}

export function formatEnv(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? '').replace(/\n/g, '\\n')}`)
    .join('\n')}\n`;
}

export async function readEnvFile(filePath) {
  return parseEnv(await fs.readFile(filePath, 'utf8'));
}

export async function writeEnvFile(filePath, values) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, formatEnv(values), 'utf8');
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function runCommand(cmd, args, options = {}) {
  const result = await execFile(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024
  });
  return {
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

export async function spawnLogged({
  cmd,
  args,
  cwd,
  env,
  stdoutPath,
  stderrPath,
  stdinText = '',
  timeoutMs = 0
}) {
  await ensureDir(path.dirname(stdoutPath));
  await ensureDir(path.dirname(stderrPath));
  const stdoutHandle = await fs.open(stdoutPath, 'w');
  const stderrHandle = await fs.open(stderrPath, 'w');

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let timedOut = false;
    let timeoutId = null;

    const finish = async (error, result) => {
      if (timeoutId) clearTimeout(timeoutId);
      await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdoutHandle.write(chunk).catch(() => {});
    });
    child.stderr.on('data', (chunk) => {
      stderrHandle.write(chunk).catch(() => {});
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`Command failed (${code ?? signal ?? 'unknown'}): ${cmd} ${args.join(' ')}`));
        return;
      }
      finish(null, { code, signal });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

export async function waitFor(check, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
  const startedAt = Date.now();
  while (true) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function withSearchPath(databaseUrl, schema) {
  const url = new URL(String(databaseUrl || ''));
  const params = new URLSearchParams(url.search);
  params.set('options', `-c search_path=${schema},public`);
  url.search = params.toString();
  return url.toString();
}

export async function symlinkForce(targetPath, linkPath) {
  await removePath(linkPath);
  await ensureDir(path.dirname(linkPath));
  await fs.symlink(targetPath, linkPath);
}

export function rootHostForTask(baseRootHost, taskSlug) {
  return `${taskSlug}.${String(baseRootHost || '').trim()}`;
}

export function replaceUrlHost(rawUrl, nextHost) {
  const url = new URL(String(rawUrl || ''));
  url.hostname = nextHost;
  return url.toString();
}

export function hostPreviewLabel(parts, suffix = '') {
  let base = parts
    .map((part) => slugify(part, { maxLength: 40 }))
    .filter(Boolean)
    .join('-') || 'app';
  const normalizedSuffix = slugify(suffix, { maxLength: 20 });
  const suffixPart = normalizedSuffix ? `--${normalizedSuffix}` : '';
  const maxBaseLength = Math.max(1, 63 - suffixPart.length);
  if (base.length > maxBaseLength) {
    base = base.slice(0, maxBaseLength).replace(/-+$/g, '');
  }
  return `${base || 'app'}${suffixPart}`;
}

export function applyTaskContextToDatabaseUrl(databaseUrl, repoRoot) {
  const url = new URL(String(databaseUrl || ''));
  const params = new URLSearchParams(url.search);
  const sslRootCert = params.get('sslrootcert');
  const localCertPath = path.join(repoRoot, 'rds-ca.pem');
  if (sslRootCert === '/etc/ssl/certs/rds-ca.pem') {
    params.set('sslrootcert', localCertPath);
    url.search = params.toString();
  }
  return url.toString();
}

export async function gitOutput(repoPath, args) {
  const { stdout } = await runCommand('git', args, { cwd: repoPath });
  return stdout;
}
