#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import {
  applyTaskContextToDatabaseUrl,
  ensureDir,
  gitOutput,
  parseEnv,
  pathExists,
  projectDatabasePrefixFromSlug,
  quoteIdent,
  readEnvFile,
  readJson,
  removePath,
  repoRootFrom,
  rootHostForTask,
  runCommand,
  schemaNameFromSlug,
  shellQuote,
  shortRandom,
  slugify,
  spawnLogged,
  symlinkForce,
  timestampSlug,
  waitFor,
  withSearchPath,
  writeEnvFile,
  writeJson
} from './lib.mjs';

const repoRoot = repoRootFrom(import.meta.url);
const promptTemplatePath = path.join(repoRoot, 'scripts', 'agent-task', 'codex-wrapper-prompt.txt');

function usage() {
  console.error(
    [
      'Usage:',
      '  node scripts/agent-task/index.mjs run --branch <feature-branch> (--prompt <text> | --prompt-file <path>) [--base main]',
      '  node scripts/agent-task/index.mjs cleanup --manifest <path> [--keep-clone]',
      '',
      'Optional flags for run:',
      '  --run-id <id>',
      '  --task-slug <slug>',
      '  --commit-message <message>',
      '  --model <model>',
      '  --timeout-minutes <minutes>',
      '  --skip-push',
      '  --skip-cleanup',
      '  --keep-clone'
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      args._.push(arg);
      continue;
    }
    if (arg === '-b') {
      args.branch = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '-p') {
      args.prompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '-f') {
      args.promptFile = argv[index + 1];
      index += 1;
      continue;
    }
    const trimmed = arg.replace(/^--/, '');
    const [rawKey, inlineValue] = trimmed.split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('-')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required argument: --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return value;
}

async function readPrompt(args) {
  if (args.prompt) return String(args.prompt);
  if (args.promptFile) {
    return fs.readFile(path.resolve(String(args.promptFile)), 'utf8');
  }
  throw new Error('Provide --prompt or --prompt-file');
}

async function saveManifest(manifest) {
  await writeJson(manifest.paths.manifestPath, manifest);
}

function codexBinaryForRepo(repoPath) {
  const candidate = path.join(repoPath, 'node_modules', '.bin', 'codex');
  return candidate;
}

async function resolveCodexBinary(repoPath) {
  const candidate = codexBinaryForRepo(repoPath);
  if (await pathExists(candidate)) return candidate;
  return 'codex';
}

function deriveTaskSlug(branch, explicitTaskSlug, runId) {
  if (explicitTaskSlug) return slugify(explicitTaskSlug, { maxLength: 28 });
  const branchSlug = slugify(branch, { maxLength: 20 });
  const suffix = slugify(runId.slice(-8), { maxLength: 8 });
  return slugify(`${branchSlug}-${suffix}`, { maxLength: 28 });
}

function buildTaskContext(baseMetadata, featureBranch, taskSlug) {
  const baseRootHost = String(baseMetadata.ROOT_HOST || '').trim();
  if (!baseRootHost) {
    throw new Error('Base replica metadata is missing ROOT_HOST');
  }
  const platformNamespace = `vibes-task-${taskSlug}`;
  return {
    slug: taskSlug,
    featureBranch,
    schema: schemaNameFromSlug(taskSlug),
    hosts: {
      root: rootHostForTask(baseRootHost, taskSlug),
      app: `app-${taskSlug}.${baseRootHost}`,
      api: `api-${taskSlug}.${baseRootHost}`,
      projectDomain: baseRootHost,
      projectSuffix: taskSlug,
      wildcardHosts: baseRootHost
    },
    namespaces: {
      platform: platformNamespace,
      development: `${platformNamespace}-dev`,
      testing: `${platformNamespace}-test`,
      production: `${platformNamespace}-prod`
    },
    workloads: {
      server: `vibes-server-${taskSlug}`,
      web: `vibes-web-${taskSlug}`,
      worker: `vibes-worker-${taskSlug}`,
      redis: `redis-${taskSlug}`,
      serverServiceAccount: 'vibes-server-sa',
      workerServiceAccount: 'worker-sa',
      serverMetricsClusterRole: 'vibes-admin-metrics-read',
      serverMetricsClusterRoleBinding: `vibes-admin-metrics-read-${taskSlug}`,
      workerClusterRole: 'worker-deployer',
      workerClusterRoleBinding: `worker-deployer-${taskSlug}`
    },
    projectDatabasePrefix: projectDatabasePrefixFromSlug(taskSlug),
    awsRegion: String(baseMetadata.AWS_REGION || 'us-east-1').trim()
  };
}

async function createClone({ sourceRepoRoot, originUrl, cloneDir, baseBranch, featureBranch }) {
  await runCommand('git', ['clone', sourceRepoRoot, cloneDir], { cwd: sourceRepoRoot });
  await runCommand('git', ['remote', 'set-url', 'origin', originUrl], { cwd: cloneDir });
  await runCommand('git', ['fetch', 'origin', '--prune'], { cwd: cloneDir });
  await runCommand('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], { cwd: cloneDir });
  await runCommand('git', ['checkout', '-b', featureBranch], { cwd: cloneDir });
}

function replaceUpgradeHost(rawUrl, host) {
  if (!rawUrl) return `https://${host}/pricing`;
  try {
    const url = new URL(rawUrl);
    url.hostname = host;
    return url.toString();
  } catch {
    return `https://${host}/pricing`;
  }
}

async function createSchema(databaseUrl, schema) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`create schema if not exists ${quoteIdent(schema)} authorization current_user`);
  } finally {
    await client.end();
  }
}

async function dropSchema(databaseUrl, schema) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`drop schema if exists ${quoteIdent(schema)} cascade`);
  } finally {
    await client.end();
  }
}

async function deleteValidationUser(databaseUrl, email) {
  if (!email) return;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('delete from users where email = $1', [email]);
  } finally {
    await client.end();
  }
}

async function dropDatabases(adminUrl, databases = []) {
  if (!databases.length) return;
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const database of databases) {
      if (!database) continue;
      try {
        await client.query(`drop database if exists ${quoteIdent(database)} with (force)`);
      } catch {
        await client.query(`drop database if exists ${quoteIdent(database)}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function apiRequest(baseUrl, route, { method = 'GET', token = '', body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const rawBody = await response.text();
  let payload = rawBody;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {}
  return { ok: response.ok, status: response.status, body: payload };
}

async function buildTaskOverlay(manifest) {
  const cloneDir = manifest.repo.cloneDir;
  const generatedDir = manifest.paths.generatedDir;
  const overlayDir = path.join(cloneDir, '.vp-task');
  await ensureDir(manifest.paths.runDir);
  await ensureDir(generatedDir);
  await ensureDir(overlayDir);

  const syncEnv = {
    ...process.env,
    REPLICA_OUTPUT_DIR: generatedDir
  };
  await runCommand('node', ['./cluster-bootstrap/sync-secrets.mjs'], {
    cwd: cloneDir,
    env: syncEnv
  });

  const baseMetadata = await readEnvFile(path.join(generatedDir, 'metadata.env'));
  const baseServerEnv = await readEnvFile(path.join(generatedDir, 'server.env'));
  const baseWebEnv = await readEnvFile(path.join(generatedDir, 'web.env'));
  const baseWorkerEnv = await readEnvFile(path.join(generatedDir, 'worker.env'));

  manifest.task = buildTaskContext(baseMetadata, manifest.repo.featureBranch, manifest.task.slug);
  manifest.database = {
    baseDatabaseUrl: applyTaskContextToDatabaseUrl(baseServerEnv.DATABASE_URL, repoRoot),
    taskDatabaseUrl: applyTaskContextToDatabaseUrl(withSearchPath(baseServerEnv.DATABASE_URL, manifest.task.schema), repoRoot),
    customerAdminUrl: applyTaskContextToDatabaseUrl(baseWorkerEnv.CUSTOMER_DB_ADMIN_URL, repoRoot)
  };

  await createSchema(manifest.database.baseDatabaseUrl, manifest.task.schema);
  manifest.resources.platformSchema = {
    schema: manifest.task.schema,
    created: true
  };

  const taskServerEnv = {
    ...baseServerEnv,
    DATABASE_URL: withSearchPath(baseServerEnv.DATABASE_URL, manifest.task.schema),
    DOMAIN: manifest.task.hosts.api,
    CORS_ORIGIN: [
      `https://${manifest.task.hosts.root}`,
      `https://${manifest.task.hosts.app}`,
      `https://${manifest.task.hosts.api}`
    ].join(','),
    PLATFORM_NAMESPACE: manifest.task.namespaces.platform,
    DEVELOPMENT_NAMESPACE: manifest.task.namespaces.development,
    TESTING_NAMESPACE: manifest.task.namespaces.testing,
    PRODUCTION_NAMESPACE: manifest.task.namespaces.production,
    RUNTIME_NAMESPACE_DEVELOPMENT: manifest.task.namespaces.development,
    RUNTIME_NAMESPACE_TESTING: manifest.task.namespaces.testing,
    RUNTIME_NAMESPACE_PRODUCTION: manifest.task.namespaces.production
  };

  const taskWebEnv = {
    ...baseWebEnv,
    API_URL: `https://${manifest.task.hosts.api}`,
    DOMAIN: manifest.task.hosts.root,
    UPGRADE_URL: replaceUpgradeHost(baseWebEnv.UPGRADE_URL, manifest.task.hosts.root)
  };

  const taskWorkerEnv = {
    ...baseWorkerEnv,
    DATABASE_URL: withSearchPath(baseWorkerEnv.DATABASE_URL, manifest.task.schema),
    DOMAIN: manifest.task.hosts.api,
    APP_DOMAIN: manifest.task.hosts.projectDomain,
    PROJECT_HOST_DOMAIN: manifest.task.hosts.projectDomain,
    PROJECT_HOST_SUFFIX: manifest.task.hosts.projectSuffix,
    PROJECT_WILDCARD_HOSTS: manifest.task.hosts.wildcardHosts,
    PROJECT_DATABASE_PREFIX: manifest.task.projectDatabasePrefix,
    SERVER_SOCKET_URL: `http://${manifest.task.workloads.server}.${manifest.task.namespaces.platform}.svc.cluster.local:80`,
    PLATFORM_NAMESPACE: manifest.task.namespaces.platform,
    DEVELOPMENT_NAMESPACE: manifest.task.namespaces.development,
    TESTING_NAMESPACE: manifest.task.namespaces.testing,
    PRODUCTION_NAMESPACE: manifest.task.namespaces.production,
    RUNTIME_NAMESPACE_DEVELOPMENT: manifest.task.namespaces.development,
    RUNTIME_NAMESPACE_TESTING: manifest.task.namespaces.testing,
    RUNTIME_NAMESPACE_PRODUCTION: manifest.task.namespaces.production,
    WORKSPACE_POD_NAMESPACE: manifest.task.namespaces.development,
    WORKER_POD_NAMESPACE: manifest.task.namespaces.platform,
    PLATFORM_SERVER_NAME: manifest.task.workloads.server,
    PLATFORM_WEB_NAME: manifest.task.workloads.web,
    PLATFORM_WORKER_NAME: manifest.task.workloads.worker,
    PLATFORM_REDIS_NAME: manifest.task.workloads.redis,
    PLATFORM_SERVER_SERVICE_ACCOUNT_NAME: manifest.task.workloads.serverServiceAccount,
    PLATFORM_WORKER_SERVICE_ACCOUNT_NAME: manifest.task.workloads.workerServiceAccount,
    PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME: manifest.task.workloads.serverMetricsClusterRole,
    PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME: manifest.task.workloads.serverMetricsClusterRoleBinding,
    PLATFORM_WORKER_CLUSTER_ROLE_NAME: manifest.task.workloads.workerClusterRole,
    PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME: manifest.task.workloads.workerClusterRoleBinding
  };

  const taskMetadataEnv = {
    ...baseMetadata,
    ROOT_HOST: manifest.task.hosts.root,
    APP_HOST: manifest.task.hosts.app,
    API_HOST: manifest.task.hosts.api,
    PLATFORM_NAMESPACE: manifest.task.namespaces.platform,
    DEVELOPMENT_NAMESPACE: manifest.task.namespaces.development,
    TESTING_NAMESPACE: manifest.task.namespaces.testing,
    PRODUCTION_NAMESPACE: manifest.task.namespaces.production,
    PLATFORM_SERVER_NAME: manifest.task.workloads.server,
    PLATFORM_WEB_NAME: manifest.task.workloads.web,
    PLATFORM_WORKER_NAME: manifest.task.workloads.worker,
    PLATFORM_REDIS_NAME: manifest.task.workloads.redis,
    PLATFORM_SERVER_SERVICE_ACCOUNT_NAME: manifest.task.workloads.serverServiceAccount,
    PLATFORM_WORKER_SERVICE_ACCOUNT_NAME: manifest.task.workloads.workerServiceAccount,
    PLATFORM_SERVER_METRICS_CLUSTER_ROLE_NAME: manifest.task.workloads.serverMetricsClusterRole,
    PLATFORM_SERVER_METRICS_CLUSTER_ROLE_BINDING_NAME: manifest.task.workloads.serverMetricsClusterRoleBinding,
    PLATFORM_WORKER_CLUSTER_ROLE_NAME: manifest.task.workloads.workerClusterRole,
    PLATFORM_WORKER_CLUSTER_ROLE_BINDING_NAME: manifest.task.workloads.workerClusterRoleBinding,
    PROJECT_HOST_DOMAIN: manifest.task.hosts.projectDomain,
    PROJECT_HOST_SUFFIX: manifest.task.hosts.projectSuffix,
    PROJECT_WILDCARD_HOSTS: manifest.task.hosts.wildcardHosts,
    PROJECT_DATABASE_PREFIX: manifest.task.projectDatabasePrefix
  };

  await Promise.all([
    writeEnvFile(path.join(generatedDir, 'server.env'), taskServerEnv),
    writeEnvFile(path.join(generatedDir, 'web.env'), taskWebEnv),
    writeEnvFile(path.join(generatedDir, 'worker.env'), taskWorkerEnv),
    writeEnvFile(path.join(generatedDir, 'metadata.env'), taskMetadataEnv)
  ]);

  const mergedRootEnv = {
    ...taskServerEnv,
    ...taskWorkerEnv,
    ...taskWebEnv
  };
  await Promise.all([
    writeEnvFile(path.join(cloneDir, '.env'), mergedRootEnv),
    writeEnvFile(path.join(cloneDir, '.env.server'), taskServerEnv),
    writeEnvFile(path.join(cloneDir, '.env.worker'), taskWorkerEnv),
    writeEnvFile(path.join(cloneDir, '.env.web'), taskWebEnv)
  ]);

  await ensureDir(path.join(cloneDir, 'deploy', '.generated'));
  await ensureDir(path.join(overlayDir, 'generated'));
  await symlinkForce(generatedDir, path.join(cloneDir, 'deploy', '.generated', 'replica'));
  await symlinkForce(generatedDir, path.join(overlayDir, 'generated', 'replica'));
  await symlinkForce(manifest.paths.manifestPath, path.join(overlayDir, 'manifest.json'));
  await writeJson(manifest.paths.metadataSnapshotPath, taskMetadataEnv);

  await writeTaskCommands(cloneDir, manifest);
  await saveManifest(manifest);
}

async function writeTaskCommands(cloneDir, manifest) {
  const overlayDir = path.join(cloneDir, '.vp-task');
  const binDir = path.join(overlayDir, 'bin');
  await ensureDir(binDir);
  const runDir = manifest.paths.runDir;
  const generatedDir = manifest.paths.generatedDir;
  const generatedEnv = `REPLICA_OUTPUT_DIR=${shellQuote(generatedDir)}`;

  const scripts = {
    'platform-urls': `#!/usr/bin/env sh
set -eu
echo "root: https://${manifest.task.hosts.root}"
echo "app:  https://${manifest.task.hosts.app}"
echo "api:  https://${manifest.task.hosts.api}"
echo "project wildcard: ${manifest.task.hosts.projectDomain}"
`,
    status: `#!/usr/bin/env sh
set -eu
echo "manifest: ${manifest.paths.manifestPath}"
echo "run dir:  ${runDir}"
echo "clone:    ${manifest.repo.cloneDir}"
echo "branch:   ${manifest.repo.featureBranch}"
echo "platform namespace: ${manifest.task.namespaces.platform}"
echo "dev namespace:      ${manifest.task.namespaces.development}"
echo "hosts:"
echo "  https://${manifest.task.hosts.root}"
echo "  https://${manifest.task.hosts.app}"
echo "  https://${manifest.task.hosts.api}"
`,
    'redeploy-platform': `#!/usr/bin/env sh
set -eu
cd ${shellQuote(manifest.repo.cloneDir)}
export ${generatedEnv}
export REPLICA_IMAGE_TAG="task-${manifest.task.slug}-manual-$(date -u +%Y%m%d%H%M%S)"
./deploy/build-push.sh
./deploy/apply-platform.sh
`,
    'validate-platform': `#!/usr/bin/env sh
set -eu
cd ${shellQuote(manifest.repo.cloneDir)}
ts="$(date -u +%Y%m%dT%H%M%SZ)"
dir=${shellQuote(path.join(runDir, 'manual-validation'))}/"$ts"
mkdir -p "$dir"
export ${generatedEnv}
export VALIDATION_METADATA_ENV_FILE=${shellQuote(path.join(generatedDir, 'metadata.env'))}
export VALIDATION_EVIDENCE_DIR="$dir"
node ./validation/run-replica-flow.mjs
echo "validation evidence: $dir"
`,
    'tail-server': `#!/usr/bin/env sh
set -eu
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} logs deploy/${shellQuote(manifest.task.workloads.server)} --tail="\${1:-200}"
`,
    'tail-worker': `#!/usr/bin/env sh
set -eu
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} logs deploy/${shellQuote(manifest.task.workloads.worker)} --tail="\${1:-200}"
`,
    'tail-web': `#!/usr/bin/env sh
set -eu
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} logs deploy/${shellQuote(manifest.task.workloads.web)} --tail="\${1:-200}"
`
  };

  for (const [name, contents] of Object.entries(scripts)) {
    const scriptPath = path.join(binDir, name);
    await fs.writeFile(scriptPath, contents, { encoding: 'utf8', mode: 0o755 });
  }

  const commandsDoc = [
    '# Task Commands',
    '',
    `Run artifacts live in \`${runDir}\`.`,
    '',
    '- `./.vp-task/bin/platform-urls` prints the task-scoped hosts.',
    '- `./.vp-task/bin/redeploy-platform` rebuilds and reapplies the task platform from this clone.',
    '- `./.vp-task/bin/validate-platform` runs the full user/project/task validation flow and writes evidence outside the clone.',
    '- `./.vp-task/bin/tail-server`, `tail-worker`, and `tail-web` stream platform logs.',
    '- `./.vp-task/bin/status` prints the manifest path and current task context.'
  ].join('\n');
  await fs.writeFile(path.join(overlayDir, 'COMMANDS.md'), `${commandsDoc}\n`, 'utf8');
}

function imageTagForPhase(manifest, phase) {
  return `task-${manifest.task.slug}-${phase}-${shortRandom(6)}`;
}

async function deployPlatform(manifest, phase) {
  const cloneDir = manifest.repo.cloneDir;
  const deployDir = path.join(manifest.paths.runDir, 'deploy', phase);
  await ensureDir(deployDir);
  const env = {
    ...process.env,
    REPLICA_OUTPUT_DIR: manifest.paths.generatedDir,
    REPLICA_IMAGE_TAG: imageTagForPhase(manifest, phase)
  };
  await spawnLogged({
    cmd: 'sh',
    args: ['./deploy/build-push.sh'],
    cwd: cloneDir,
    env,
    stdoutPath: path.join(deployDir, 'build.stdout.log'),
    stderrPath: path.join(deployDir, 'build.stderr.log'),
    timeoutMs: 90 * 60 * 1000
  });
  await spawnLogged({
    cmd: 'sh',
    args: ['./deploy/apply-platform.sh'],
    cwd: cloneDir,
    env,
    stdoutPath: path.join(deployDir, 'apply.stdout.log'),
    stderrPath: path.join(deployDir, 'apply.stderr.log'),
    timeoutMs: 45 * 60 * 1000
  });
  const imagesEnv = await readEnvFile(path.join(manifest.paths.generatedDir, 'images.env'));
  const imageRefs = [imagesEnv.SERVER_IMAGE, imagesEnv.WEB_IMAGE, imagesEnv.WORKER_IMAGE].filter(Boolean);
  manifest.resources.platformImages = Array.from(new Set([...(manifest.resources.platformImages || []), ...imageRefs]));
  manifest.status.lastDeploy = {
    phase,
    completedAt: new Date().toISOString(),
    imageTag: imagesEnv.IMAGE_TAG || env.REPLICA_IMAGE_TAG
  };
  await saveManifest(manifest);
}

async function buildCodexPrompt(manifest, prompt) {
  const template = await fs.readFile(promptTemplatePath, 'utf8');
  return template
    .replaceAll('{{FEATURE_BRANCH}}', manifest.repo.featureBranch)
    .replaceAll('{{BASE_BRANCH}}', manifest.repo.baseBranch)
    .replaceAll('{{MANIFEST_PATH}}', manifest.paths.manifestPath)
    .replaceAll('{{COMMANDS_PATH}}', path.join(manifest.repo.cloneDir, '.vp-task', 'COMMANDS.md'))
    .replaceAll('{{API_URL}}', `https://${manifest.task.hosts.api}`)
    .replaceAll('{{APP_URL}}', `https://${manifest.task.hosts.app}`)
    .replaceAll('{{ROOT_HOST}}', manifest.task.hosts.root)
    .replaceAll('{{PROMPT}}', prompt.trim());
}

async function runCodex(manifest, prompt, model, timeoutMs) {
  const codexDir = path.join(manifest.paths.runDir, 'codex');
  await ensureDir(codexDir);
  const binary = await resolveCodexBinary(repoRoot);
  const fullPrompt = await buildCodexPrompt(manifest, prompt);
  const mergedEnv = parseEnv(await fs.readFile(path.join(manifest.repo.cloneDir, '.env'), 'utf8'));
  const env = {
    ...process.env,
    ...mergedEnv
  };
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--json',
    '-o',
    path.join(codexDir, 'last-message.txt'),
    '-m',
    model,
    '-c',
    'reasoning.effort="xhigh"',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    manifest.repo.cloneDir
  ];
  await spawnLogged({
    cmd: binary,
    args,
    cwd: repoRoot,
    env,
    stdinText: fullPrompt,
    stdoutPath: path.join(codexDir, 'stdout.jsonl'),
    stderrPath: path.join(codexDir, 'stderr.log'),
    timeoutMs
  });
  manifest.status.codex = {
    model,
    completedAt: new Date().toISOString(),
    lastMessagePath: path.join(codexDir, 'last-message.txt')
  };
  await saveManifest(manifest);
}

async function runValidation(manifest, label) {
  const evidenceDir = path.join(manifest.paths.runDir, 'validation', label);
  await ensureDir(evidenceDir);
  await spawnLogged({
    cmd: 'node',
    args: ['./validation/run-replica-flow.mjs'],
    cwd: manifest.repo.cloneDir,
    env: {
      ...process.env,
      REPLICA_OUTPUT_DIR: manifest.paths.generatedDir,
      VALIDATION_METADATA_ENV_FILE: path.join(manifest.paths.generatedDir, 'metadata.env'),
      VALIDATION_EVIDENCE_DIR: evidenceDir
    },
    stdoutPath: path.join(evidenceDir, 'validation.stdout.log'),
    stderrPath: path.join(evidenceDir, 'validation.stderr.log'),
    timeoutMs: 60 * 60 * 1000
  });
  const summaryPath = path.join(evidenceDir, 'summary.json');
  const summary = await readJson(summaryPath);
  manifest.validation = {
    lastLabel: label,
    lastEvidenceDir: evidenceDir,
    lastSummaryPath: summaryPath
  };
  await saveManifest(manifest);
  return summary;
}

async function cleanupValidation(manifest) {
  if (!manifest.validation?.lastEvidenceDir || !manifest.validation?.lastSummaryPath) return;
  const summary = await readJson(manifest.validation.lastSummaryPath);
  const registerPath = path.join(manifest.validation.lastEvidenceDir, '01-register.json');
  let token = '';
  if (await pathExists(registerPath)) {
    const register = await readJson(registerPath);
    token = String(register?.body?.token || '').trim();
  }

  if (token && summary?.project?.id) {
    await apiRequest(summary.api_base_url, `/projects/${summary.project.id}`, {
      method: 'DELETE',
      token
    }).catch(() => null);
    await waitFor(async () => {
      const response = await apiRequest(summary.api_base_url, '/projects', { token }).catch(() => null);
      if (!response?.ok || !Array.isArray(response.body)) return false;
      return !response.body.some((project) => project.id === summary.project.id);
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 5000 }).catch(() => null);
  }

  const databaseNames = Array.isArray(summary?.project?.databases)
    ? summary.project.databases.map((entry) => entry.db_name).filter(Boolean)
    : [];
  await dropDatabases(manifest.database.customerAdminUrl, databaseNames);
  await deleteValidationUser(manifest.database.taskDatabaseUrl, summary?.user?.email || '');
  manifest.cleanup.validation = {
    completedAt: new Date().toISOString(),
    databases: databaseNames
  };
  await saveManifest(manifest);
}

function forbiddenValuesForManifest(manifest) {
  return [
    manifest.task.schema,
    manifest.task.slug,
    manifest.task.hosts.root,
    manifest.task.hosts.app,
    manifest.task.hosts.api,
    manifest.task.hosts.projectSuffix,
    manifest.task.projectDatabasePrefix,
    manifest.task.namespaces.platform,
    manifest.task.namespaces.development,
    manifest.task.namespaces.testing,
    manifest.task.namespaces.production,
    manifest.paths.runDir,
    '.vp-task',
    '.codex-last-message.txt',
    'deploy/.generated/replica'
  ].filter(Boolean);
}

async function sanitizeClone(manifest) {
  const cloneDir = manifest.repo.cloneDir;
  await Promise.all([
    removePath(path.join(cloneDir, '.vp-task')),
    removePath(path.join(cloneDir, 'deploy', '.generated')),
    removePath(path.join(cloneDir, '.env')),
    removePath(path.join(cloneDir, '.env.server')),
    removePath(path.join(cloneDir, '.env.worker')),
    removePath(path.join(cloneDir, '.env.web')),
    removePath(path.join(cloneDir, '.env.local')),
    removePath(path.join(cloneDir, '.codex-last-message.txt'))
  ]);

  const diff = await gitOutput(cloneDir, ['diff', '--binary']);
  const stagedDiff = await gitOutput(cloneDir, ['diff', '--cached', '--binary']).catch(() => '');
  const combinedDiff = `${diff}\n${stagedDiff}`;
  const forbiddenMatches = forbiddenValuesForManifest(manifest).filter((value) => combinedDiff.includes(value));
  if (forbiddenMatches.length) {
    throw new Error(`Task-only values still appear in tracked changes: ${forbiddenMatches.join(', ')}`);
  }

  const status = await gitOutput(cloneDir, ['status', '--porcelain']);
  const lines = status.split('\n').map((line) => line.trim()).filter(Boolean);
  const leaked = lines.filter((line) => line.includes('.vp-task') || line.includes('.env') || line.includes('.generated'));
  if (leaked.length) {
    throw new Error(`Generated task plumbing is still present in git status: ${leaked.join(', ')}`);
  }

  manifest.status.sanitizedAt = new Date().toISOString();
  await saveManifest(manifest);
}

async function commitAndPush(manifest, commitMessage, skipPush) {
  const cloneDir = manifest.repo.cloneDir;
  await runCommand('git', ['add', '-A'], { cwd: cloneDir });
  const status = await gitOutput(cloneDir, ['status', '--porcelain']);
  if (!status.trim()) {
    throw new Error('No tracked changes remain after sanitation; nothing to commit');
  }
  await runCommand('git', ['commit', '-m', commitMessage], { cwd: cloneDir });
  if (!skipPush) {
    await runCommand('git', ['push', '-u', 'origin', `HEAD:${manifest.repo.featureBranch}`], { cwd: cloneDir });
  }
  manifest.status.publish = {
    committedAt: new Date().toISOString(),
    skipPush: Boolean(skipPush)
  };
  await saveManifest(manifest);
}

function parseImageRef(imageRef) {
  const slashIndex = imageRef.indexOf('/');
  const colonIndex = imageRef.lastIndexOf(':');
  if (slashIndex === -1 || colonIndex === -1 || colonIndex < slashIndex) return null;
  return {
    repositoryName: imageRef.slice(slashIndex + 1, colonIndex),
    tag: imageRef.slice(colonIndex + 1)
  };
}

async function cleanupPlatformImages(manifest) {
  const refs = Array.isArray(manifest.resources.platformImages) ? manifest.resources.platformImages : [];
  for (const ref of refs) {
    const parsed = parseImageRef(ref);
    if (!parsed?.repositoryName || !parsed?.tag) continue;
    await runCommand('aws', [
      'ecr',
      'batch-delete-image',
      '--repository-name',
      parsed.repositoryName,
      '--region',
      manifest.task.awsRegion,
      '--image-ids',
      `imageTag=${parsed.tag}`
    ]).catch(() => null);
  }
}

async function deleteNamespaces(manifest) {
  const namespaces = Object.values(manifest.task.namespaces);
  for (const namespace of namespaces) {
    await runCommand('kubectl', ['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']).catch(() => null);
  }
  for (const namespace of namespaces) {
    await waitFor(async () => {
      try {
        await runCommand('kubectl', ['get', 'namespace', namespace]);
        return false;
      } catch {
        return true;
      }
    }, { timeoutMs: 15 * 60 * 1000, intervalMs: 5000 }).catch(() => null);
  }
}

async function cleanupManifest(manifest, { keepClone = false } = {}) {
  const errors = [];
  try {
    await cleanupValidation(manifest);
  } catch (error) {
    errors.push(`validation cleanup: ${error.message}`);
  }
  try {
    await spawnLogged({
      cmd: 'sh',
      args: ['./deploy/destroy-platform.sh'],
      cwd: manifest.repo.cloneDir,
      env: {
        ...process.env,
        REPLICA_OUTPUT_DIR: manifest.paths.generatedDir,
        DELETE_PLATFORM_CLUSTER_ROLES: 'false'
      },
      stdoutPath: path.join(manifest.paths.runDir, 'cleanup', 'destroy.stdout.log'),
      stderrPath: path.join(manifest.paths.runDir, 'cleanup', 'destroy.stderr.log'),
      timeoutMs: 30 * 60 * 1000
    });
  } catch (error) {
    errors.push(`destroy-platform: ${error.message}`);
  }
  try {
    await deleteNamespaces(manifest);
  } catch (error) {
    errors.push(`namespace delete: ${error.message}`);
  }
  try {
    await cleanupPlatformImages(manifest);
  } catch (error) {
    errors.push(`image cleanup: ${error.message}`);
  }
  try {
    await dropSchema(manifest.database.baseDatabaseUrl, manifest.task.schema);
  } catch (error) {
    errors.push(`schema cleanup: ${error.message}`);
  }
  if (!keepClone) {
    await removePath(manifest.repo.cloneDir);
  }
  manifest.cleanup = {
    ...(manifest.cleanup || {}),
    completedAt: new Date().toISOString(),
    keepClone,
    errors
  };
  await saveManifest(manifest);
  if (errors.length) {
    throw new Error(`Cleanup completed with errors: ${errors.join(' | ')}`);
  }
}

async function runFlow(args) {
  const baseBranch = String(args.base || 'main');
  const featureBranch = requiredArg(args, 'branch');
  const prompt = await readPrompt(args);
  const runId = String(args.runId || `${timestampSlug()}-${shortRandom(6)}`);
  const taskSlug = deriveTaskSlug(featureBranch, args.taskSlug, runId);
  const runDir = path.join(repoRoot, 'validation', 'evidence', 'agent-cli', runId);
  const cloneDir = path.join(runDir, 'clone');
  const generatedDir = path.join(runDir, 'generated', 'replica');
  await ensureDir(runDir);

  const manifest = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    repo: {
      sourceRoot: repoRoot,
      originUrl: await gitOutput(repoRoot, ['remote', 'get-url', 'origin']),
      baseBranch,
      featureBranch,
      cloneDir
    },
    paths: {
      runDir,
      manifestPath: path.join(runDir, 'manifest.json'),
      generatedDir,
      metadataSnapshotPath: path.join(runDir, 'metadata.snapshot.json')
    },
    task: {
      slug: taskSlug
    },
    resources: {
      platformImages: []
    },
    cleanup: {},
    status: {}
  };
  await saveManifest(manifest);

  const keepClone = Boolean(args.keepClone);
  const skipCleanup = Boolean(args.skipCleanup);
  let success = false;
  try {
    await createClone({
      sourceRepoRoot: repoRoot,
      originUrl: manifest.repo.originUrl,
      cloneDir,
      baseBranch,
      featureBranch
    });
    await buildTaskOverlay(manifest);
    await deployPlatform(manifest, 'pre-codex');
    await runCodex(
      manifest,
      prompt,
      String(args.model || 'gpt-5.4'),
      Math.max(15, Number(args.timeoutMinutes || 120)) * 60 * 1000
    );
    await deployPlatform(manifest, 'post-codex');
    await runValidation(manifest, 'post-codex');
    await sanitizeClone(manifest);
    await commitAndPush(
      manifest,
      String(args.commitMessage || `feat: ${featureBranch}`),
      Boolean(args.skipPush)
    );
    success = true;
  } finally {
    if (!skipCleanup) {
      await cleanupManifest(manifest, { keepClone }).catch((error) => {
        console.error(error.message);
      });
    }
  }
}

async function cleanupFlow(args) {
  const manifestPath = path.resolve(requiredArg(args, 'manifest'));
  const manifest = await readJson(manifestPath);
  await cleanupManifest(manifest, { keepClone: Boolean(args.keepClone) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'run';
  if (command === 'run') {
    await runFlow(args);
    return;
  }
  if (command === 'cleanup') {
    await cleanupFlow(args);
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
