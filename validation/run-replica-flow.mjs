#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const generatedDir = process.env.REPLICA_OUTPUT_DIR || path.join(repoRoot, 'deploy', '.generated', 'replica');
const metadataEnvPath = process.env.VALIDATION_METADATA_ENV_FILE || path.join(generatedDir, 'metadata.env');

function parseEnv(text) {
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

function normalizeDnsLabelSegment(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildHostLabel(parts, suffix = '') {
  let base = parts.map((part) => normalizeDnsLabelSegment(part)).filter(Boolean).join('-') || 'app';
  const normalizedSuffix = normalizeDnsLabelSegment(suffix);
  const suffixPart = normalizedSuffix ? `--${normalizedSuffix}` : '';
  const maxBaseLength = Math.max(1, 63 - suffixPart.length);
  if (base.length > maxBaseLength) {
    base = base.slice(0, maxBaseLength).replace(/-+$/g, '');
  }
  return `${base || 'app'}${suffixPart}`;
}

function previewHostForProject(project, metadataEnv, environment = 'development') {
  const domain = String(metadataEnv.PROJECT_HOST_DOMAIN || metadataEnv.ROOT_HOST || '').trim();
  const suffix = String(metadataEnv.PROJECT_HOST_SUFFIX || '').trim();
  const slug = project?.project_slug || 'app';
  const shortId = project?.short_id || '';
  if (!domain) {
    throw new Error('metadata env is missing PROJECT_HOST_DOMAIN/ROOT_HOST');
  }
  return `${buildHostLabel([slug, environment, shortId], suffix)}.${domain}`;
}

function deriveProjectDatabaseName(shortId, environment, metadataEnv) {
  const safe = `${shortId}-${environment}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const rawPrefix = String(metadataEnv.PROJECT_DATABASE_PREFIX || 'vibes')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '') || 'vibes';
  const maxPrefixLength = Math.max(1, 63 - safe.length - 1);
  const prefix = rawPrefix.slice(0, maxPrefixLength).replace(/_+$/g, '') || 'vibes';
  return `${prefix}_${safe}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(cmd, args, options = {}) {
  const { stdout } = await execFile(cmd, args, {
    cwd: options.cwd,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function extractScriptSrcs(html) {
  return Array.from(String(html || '').matchAll(/<script[^>]+src="([^"]+)"/g), (match) => match[1]);
}

function extractImportSpecifiers(sourceText) {
  const imports = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g,
    /import\(["']([^"']+)["']\)/g
  ];
  for (const pattern of patterns) {
    for (const match of String(sourceText || '').matchAll(pattern)) {
      const specifier = String(match[1] || '').trim();
      if (!specifier || specifier.startsWith('data:')) continue;
      imports.add(specifier);
    }
  }
  return Array.from(imports);
}

async function findMarkerInPreviewResources(previewUrl, html, marker, lookup, evidenceDir) {
  const baseUrl = new URL(previewUrl);
  const queue = extractScriptSrcs(html).map((src) => new URL(src, baseUrl).toString());
  const visited = new Set();
  let fetched = 0;

  while (queue.length > 0 && fetched < 30) {
    const resourceUrl = queue.shift();
    if (!resourceUrl || visited.has(resourceUrl)) continue;
    visited.add(resourceUrl);

    let response;
    try {
      response = await httpRequest(resourceUrl, { lookup });
    } catch {
      continue;
    }
    if (!response.ok) continue;

    const bodyText = response.body.toString('utf8');
    fetched += 1;

    const fileUrl = new URL(resourceUrl);
    const ext = path.extname(fileUrl.pathname) || '.txt';
    const fileName = `07-preview-resource-${String(fetched).padStart(2, '0')}${ext}`;
    await fs.writeFile(path.join(evidenceDir, fileName), bodyText, 'utf8');

    if (bodyText.includes(marker)) {
      return {
        matched: true,
        resourceUrl,
        evidenceFile: fileName
      };
    }

    for (const specifier of extractImportSpecifiers(bodyText)) {
      let resolved;
      try {
        resolved = new URL(specifier, resourceUrl);
      } catch {
        continue;
      }
      if (resolved.origin !== baseUrl.origin) continue;
      queue.push(resolved.toString());
    }
  }

  return { matched: false };
}

function httpRequest(url, options = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const headers = {
    ...(options.headers || {})
  };
  const timeoutMs = Number(options.timeoutMs || process.env.VALIDATION_HTTP_TIMEOUT_MS || 20000);

  let payload = null;
  if (options.body) {
    payload = Buffer.from(JSON.stringify(options.body));
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    headers['Content-Length'] = String(payload.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${url}`));
    }, timeoutMs);
    const req = client.request(
      target,
      {
        method: options.method || 'GET',
        headers,
        lookup: options.lookup,
        servername: target.hostname
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          settled = true;
          clearTimeout(timeoutId);
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value || '')])),
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${url}`));
    });
    req.on('error', (error) => {
      clearTimeout(timeoutId);
      if (settled) return;
      reject(error);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function apiRequest(baseUrl, route, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await httpRequest(`${baseUrl}${route}`, {
    method: options.method,
    headers,
    body: options.body,
    lookup: options.lookup
  });

  if (options.responseType === 'buffer') {
    return response;
  }

  let data = null;
  try {
    data = JSON.parse(response.body.toString('utf8'));
  } catch {
    data = response.body.toString('utf8');
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: data
  };
}

async function waitForPreviewMarker({
  label,
  previewUrl,
  marker,
  lookup,
  evidenceDir,
  htmlFile,
  matchFile,
  onRetry
}) {
  const result = await pollUntil(
    label,
    async (attempt) => {
      if (onRetry && attempt > 1 && attempt % 6 === 0) {
        await onRetry(attempt).catch(() => null);
      }

      const response = await httpRequest(previewUrl, { lookup });
      const html = response.body.toString('utf8');
      await fs.writeFile(path.join(evidenceDir, htmlFile), html, 'utf8');
      if (response.ok && html.includes(marker)) {
        return { done: true, value: { html, matchedIn: 'html', resourceUrl: null, evidenceFile: null } };
      }
      if (response.ok) {
        const resourceMatch = await findMarkerInPreviewResources(
          previewUrl,
          html,
          marker,
          lookup,
          evidenceDir
        );
        if (resourceMatch.matched) {
          return {
            done: true,
            value: {
              html,
              matchedIn: 'resource',
              resourceUrl: resourceMatch.resourceUrl,
              evidenceFile: resourceMatch.evidenceFile
            }
          };
        }
      }
      return { done: false };
    },
    15 * 60 * 1000,
    10000
  );

  await fs.writeFile(path.join(evidenceDir, htmlFile), result.html, 'utf8');
  await writeJson(path.join(evidenceDir, matchFile), {
    matched_in: result.matchedIn,
    resource_url: result.resourceUrl,
    evidence_file: result.evidenceFile
  });
  return result;
}

async function pollUntil(label, fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const result = await fn(attempt);
    if (result?.done) return result.value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out while waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

async function ensureMarkerInRepo(downloadPath, extractDir, marker) {
  const lower = downloadPath.toLowerCase();
  if (lower.endsWith('.bundle') || lower.endsWith('.gitbundle')) {
    await run('git', ['clone', downloadPath, extractDir]);
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await fs.mkdir(extractDir, { recursive: true });
    await run('tar', ['-xzf', downloadPath, '-C', extractDir]);
  } else {
    throw new Error(`Unsupported repo artifact format: ${downloadPath}`);
  }

  const rgPath = await run('sh', ['-lc', 'command -v rg || true']);
  if (rgPath) {
    const matches = await run('rg', ['-n', marker, extractDir]);
    return matches;
  }

  return run('grep', ['-R', '-n', marker, extractDir]);
}

const metadataEnv = parseEnv(await fs.readFile(metadataEnvPath, 'utf8'));
const platformNamespace = process.env.VALIDATION_PLATFORM_NAMESPACE || metadataEnv.PLATFORM_NAMESPACE || 'vibes-platform';
const platformWebIngress = process.env.VALIDATION_PLATFORM_WEB_NAME || metadataEnv.PLATFORM_WEB_NAME || 'vibes-web';
const apiBaseUrl = `https://${metadataEnv.API_HOST}`;
const sharedAlbDnsName = await run('kubectl', [
  '-n',
  platformNamespace,
  'get',
  'ingress',
  platformWebIngress,
  '-o',
  'jsonpath={.status.loadBalancer.ingress[0].hostname}'
]);

function resolveForRequest(hostname, callback, all = false) {
  dns.resolve4(hostname, (resolve4Error, addresses) => {
    if (!resolve4Error && Array.isArray(addresses) && addresses.length > 0) {
      if (all) {
        callback(null, addresses.map((address) => ({ address, family: 4 })));
        return;
      }
      callback(null, addresses[0], 4);
      return;
    }

    const publicResolver = new dns.Resolver();
    publicResolver.setServers(['8.8.8.8', '1.1.1.1']);
    publicResolver.resolve4(hostname, (publicResolveError, publicAddresses) => {
      if (!publicResolveError && Array.isArray(publicAddresses) && publicAddresses.length > 0) {
        if (all) {
          callback(null, publicAddresses.map((address) => ({ address, family: 4 })));
          return;
        }
        callback(null, publicAddresses[0], 4);
        return;
      }

      dns.lookup(hostname, all ? { all: true } : {}, callback);
    });
  });
}

function replicaLookup(hostname, options, callback) {
  const all = typeof options === 'object' && options?.all;
  const targetHost = sharedAlbDnsName && (hostname === metadataEnv.ROOT_HOST || hostname.endsWith(`.${metadataEnv.ROOT_HOST}`))
    ? sharedAlbDnsName
    : hostname;
  resolveForRequest(targetHost, callback, all);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = process.env.VALIDATION_EVIDENCE_DIR
  ? path.resolve(process.env.VALIDATION_EVIDENCE_DIR)
  : path.join(repoRoot, 'validation', 'evidence', timestamp);

await fs.mkdir(evidenceDir, { recursive: true });

const marker = `VIBES_REPLICA_VALIDATION_${timestamp.replace(/[^A-Za-z0-9]/g, '_')}`;
const email = `replica-validation-${Date.now()}@example.test`;
const password = `Replica-${Date.now()}!`;
const projectName = `Replica Validation ${timestamp}`;

const registerRes = await apiRequest(apiBaseUrl, '/auth/register', {
  method: 'POST',
  lookup: replicaLookup,
  body: { email, password }
});
await writeJson(path.join(evidenceDir, '01-register.json'), registerRes);
if (!registerRes.ok) {
  throw new Error(`Registration failed with status ${registerRes.status}`);
}

const token = registerRes.body?.token;
if (!token) {
  throw new Error('Registration did not return an auth token');
}

const createProjectRes = await apiRequest(apiBaseUrl, '/projects', {
  method: 'POST',
  lookup: replicaLookup,
  token,
  body: {
    name: projectName,
    stackType: 'web',
    interfaces: ['web']
  }
});
await writeJson(path.join(evidenceDir, '02-project-create.json'), createProjectRes);
if (!createProjectRes.ok) {
  throw new Error(`Project creation failed with status ${createProjectRes.status}`);
}

const project = createProjectRes.body;
const projectId = project.id;
if (!projectId) {
  throw new Error('Project creation response did not include an id');
}

const projectReady = await pollUntil(
  'starter snapshot readiness',
  async () => {
    const res = await apiRequest(apiBaseUrl, '/projects', { token, lookup: replicaLookup });
    await writeJson(path.join(evidenceDir, '03-projects-poll.json'), res);
    if (!res.ok) {
      return { done: false };
    }
    const current = Array.isArray(res.body) ? res.body.find((item) => item.id === projectId) : null;
    if (!current) {
      return { done: false };
    }
    if (current.snapshot_status === 'ready') {
      return { done: true, value: current };
    }
    return { done: false };
  },
  20 * 60 * 1000,
  5000
);

const prompt = [
  `Open the main user-facing web interface and add the exact text "${marker}" somewhere visible in the default page output.`,
  'Keep the change minimal and safe.',
  'Return a short summary of the file you changed.'
].join(' ');

const createTaskRes = await apiRequest(apiBaseUrl, `/projects/${projectId}/tasks`, {
  method: 'POST',
  lookup: replicaLookup,
  token,
  body: {
    prompt,
    environment: 'development'
  }
});
await writeJson(path.join(evidenceDir, '04-task-create.json'), createTaskRes);
if (!createTaskRes.ok) {
  throw new Error(`Task creation failed with status ${createTaskRes.status}`);
}

const taskId = createTaskRes.body?.id;
if (!taskId) {
  throw new Error('Task creation response did not include a task id');
}

const completedTask = await pollUntil(
  'task completion',
  async () => {
    const res = await apiRequest(apiBaseUrl, `/projects/${projectId}/tasks`, { token, lookup: replicaLookup });
    await writeJson(path.join(evidenceDir, '05-tasks-poll.json'), res);
    if (!res.ok) {
      return { done: false };
    }
    const current = Array.isArray(res.body) ? res.body.find((item) => item.id === taskId) : null;
    if (!current) {
      return { done: false };
    }
    if (current.status === 'completed' && current.commit_hash) {
      return { done: true, value: current };
    }
    if (current.status === 'failed' || current.status === 'cancelled') {
      throw new Error(`Task ${taskId} ended with status ${current.status}`);
    }
    return { done: false };
  },
  30 * 60 * 1000,
  10000
);

const wakeRes = await apiRequest(apiBaseUrl, `/projects/${projectId}/development/wake`, {
  method: 'POST',
  lookup: replicaLookup,
  token,
  body: {
    mode: 'workspace',
    taskId
  }
});
await writeJson(path.join(evidenceDir, '06-preview-wake.json'), wakeRes);

const previewHost = previewHostForProject(projectReady, metadataEnv, 'development');
const previewUrl = `https://${previewHost}`;
await waitForPreviewMarker({
  label: 'preview marker',
  previewUrl,
  marker,
  lookup: replicaLookup,
  evidenceDir,
  htmlFile: '07-preview-final.html',
  matchFile: '07-preview-match.json',
  onRetry: async () => apiRequest(apiBaseUrl, `/projects/${projectId}/development/wake`, {
    method: 'POST',
    lookup: replicaLookup,
    token,
    body: {
      mode: 'workspace',
      taskId
    }
  })
});

await pollUntil(
  'workspace activation',
  async () => {
    const res = await apiRequest(apiBaseUrl, '/projects', { token, lookup: replicaLookup });
    const currentProject = Array.isArray(res.body)
      ? res.body.find((item) => item.id === projectId) || null
      : null;
    await writeJson(path.join(evidenceDir, '07-preview-state.json'), {
      project: currentProject
    });
    const env = currentProject?.environments?.development || {};
    if (
      env.preview_mode === 'workspace' &&
      env.workspace_state === 'ready' &&
      env.live_commit_sha === completedTask.commit_hash &&
      env.selected_mode === 'workspace'
    ) {
      return { done: true, value: currentProject };
    }
    return { done: false };
  },
  10 * 60 * 1000,
  5000
);

const fullBuildWakeRes = await apiRequest(apiBaseUrl, `/projects/${projectId}/development/wake`, {
  method: 'POST',
  lookup: replicaLookup,
  token,
  body: {
    mode: 'verified',
    taskId
  }
});
await writeJson(path.join(evidenceDir, '08-full-build-wake.json'), fullBuildWakeRes);

const fullBuildResult = await pollUntil(
  'full build completion',
  async (attempt) => {
    if (attempt > 1 && attempt % 6 === 0) {
      await apiRequest(apiBaseUrl, `/projects/${projectId}/development/wake`, {
        method: 'POST',
        lookup: replicaLookup,
        token,
        body: {
          mode: 'verified',
          taskId
        }
      }).catch(() => null);
    }

    const [buildRes, projectsRes] = await Promise.all([
      apiRequest(apiBaseUrl, `/projects/${projectId}/builds/latest?environment=development`, {
        token,
        lookup: replicaLookup
      }),
      apiRequest(apiBaseUrl, '/projects', { token, lookup: replicaLookup })
    ]);
    const currentProject = Array.isArray(projectsRes.body)
      ? projectsRes.body.find((item) => item.id === projectId) || null
      : null;
    const currentDevelopment = currentProject?.environments?.development || null;
    await writeJson(path.join(evidenceDir, '08-full-build-poll.json'), {
      build: buildRes,
      project: currentProject
    });
    const status = String(buildRes.body?.status || currentDevelopment?.build_status || '').toLowerCase();
    const refCommit = String(
      buildRes.body?.ref_commit ||
      currentDevelopment?.full_build_commit_sha ||
      currentDevelopment?.live_commit_sha ||
      ''
    ).trim();
    if (status === 'live' && refCommit === completedTask.commit_hash) {
      return {
        done: true,
        value: {
          build: buildRes.body || {
            id: null,
            status: 'live',
            ref_commit: refCommit
          },
          project: currentProject
        }
      };
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Full build ${status}: ${buildRes.body?.build_log || 'no build log available'}`);
    }
    return { done: false };
  },
  30 * 60 * 1000,
  10000
);

await waitForPreviewMarker({
  label: 'verified marker',
  previewUrl,
  marker,
  lookup: replicaLookup,
  evidenceDir,
  htmlFile: '08-verified-final.html',
  matchFile: '08-verified-match.json',
  onRetry: async () => apiRequest(apiBaseUrl, `/projects/${projectId}/development/wake`, {
    method: 'POST',
    lookup: replicaLookup,
    token,
    body: {
      mode: 'verified',
      taskId
    }
  })
});

const runtimeLogsRes = await apiRequest(
  apiBaseUrl,
  `/projects/${projectId}/runtime-logs?environment=development&includePrevious=true&lines=400`,
  { token, lookup: replicaLookup }
);
await writeJson(path.join(evidenceDir, '09-runtime-logs.json'), runtimeLogsRes);

const repoDownloadRes = await apiRequest(apiBaseUrl, `/projects/${projectId}/repo-download`, {
  token,
  lookup: replicaLookup,
  responseType: 'buffer'
});
if (!repoDownloadRes.ok) {
  throw new Error(`Repo download failed with status ${repoDownloadRes.status}`);
}

const disposition = String(repoDownloadRes.headers['content-disposition'] || '');
const fileNameMatch = disposition.match(/filename="?([^"]+)"?/i);
const artifactName = fileNameMatch?.[1] || `${projectReady.project_slug}.bundle`;
const artifactPath = path.join(evidenceDir, artifactName);
await fs.writeFile(artifactPath, repoDownloadRes.body);

const extractDir = path.join(evidenceDir, 'repo');
const repoMatches = await ensureMarkerInRepo(artifactPath, extractDir, marker);
await fs.writeFile(path.join(evidenceDir, '10-repo-marker.txt'), `${repoMatches}\n`, 'utf8');

const summary = {
  executed_at: new Date().toISOString(),
  api_base_url: apiBaseUrl,
  preview_url: previewUrl,
  marker,
  user: {
    email,
    password
  },
  project: {
    id: projectId,
    name: projectName,
    short_id: projectReady.short_id,
    project_slug: projectReady.project_slug,
    databases: ['development', 'testing', 'production'].map((environment) => ({
      environment,
      db_name: deriveProjectDatabaseName(projectReady.short_id, environment, metadataEnv)
    }))
  },
  task: {
    id: taskId,
    status: completedTask.status,
    commit_hash: completedTask.commit_hash
  },
  full_build: {
    id: fullBuildResult.build.id,
    status: fullBuildResult.build.status,
    ref_commit: fullBuildResult.build.ref_commit
  },
  platform: {
    namespace: platformNamespace,
    web_ingress: platformWebIngress,
    api_host: metadataEnv.API_HOST,
    app_host: metadataEnv.APP_HOST,
    root_host: metadataEnv.ROOT_HOST,
    project_host_domain: metadataEnv.PROJECT_HOST_DOMAIN || metadataEnv.ROOT_HOST,
    project_host_suffix: metadataEnv.PROJECT_HOST_SUFFIX || ''
  },
  artifact_path: artifactPath,
  evidence_dir: evidenceDir
};

await writeJson(path.join(evidenceDir, 'summary.json'), summary);

console.log(`[replica] Validation passed. Evidence written to ${evidenceDir}`);
