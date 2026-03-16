#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
const PLATFORM_NODEGROUP_NAME = 'platform-core';
const MIN_PLATFORM_NODE_COUNT = 2;

function usage() {
  console.error(
    [
      'Usage:',
      '  node scripts/agent-task/index.mjs run --branch <feature-branch> (--prompt <text> | --prompt-file <path>) [--base main]',
      '  node scripts/agent-task/index.mjs resume --manifest <path> [--keep-clone] [--skip-cleanup]',
      '  node scripts/agent-task/index.mjs cleanup --manifest <path> [--keep-clone]',
      '  node scripts/agent-task/index.mjs janitor [--runs-root <path>] [--older-than-hours <hours>] [--apply] [--keep-clone]',
      '',
      'Optional flags for run:',
      '  --run-id <id>',
      '  --task-slug <slug>',
      '  --commit-message <message>',
      '  --model <model>',
      '  --timeout-minutes <minutes>',
      '  --feature-validation-cmd <shell command>',
      '  --feature-validation-file <path>',
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

async function readFeatureValidationCommand(args) {
  if (args.featureValidationCmd) return String(args.featureValidationCmd).trim();
  if (args.featureValidationFile) {
    return String(await fs.readFile(path.resolve(String(args.featureValidationFile)), 'utf8')).trim();
  }
  return '';
}

async function ensureKubeAccess() {
  try {
    await runCommand('kubectl', ['get', 'ns', '--request-timeout=15s']);
    return;
  } catch (originalError) {
    const metadataPath = path.join(repoRoot, 'deploy', '.generated', 'replica', 'metadata.env');
    let region = 'us-east-1';
    if (await pathExists(metadataPath)) {
      const metadata = await readEnvFile(metadataPath);
      region = String(metadata.AWS_REGION || region).trim() || region;
    }
    let clusters = [];
    try {
      const { stdout } = await runCommand('aws', ['eks', 'list-clusters', '--region', region, '--output', 'json']);
      const payload = JSON.parse(stdout || '{}');
      clusters = Array.isArray(payload?.clusters) ? payload.clusters : [];
    } catch {}
    if (clusters.length === 1) {
      const clusterName = String(clusters[0] || '').trim();
      if (!clusterName) throw originalError;
      await runCommand('aws', ['eks', 'update-kubeconfig', '--region', region, '--name', clusterName, '--alias', clusterName]);
      await runCommand('kubectl', ['config', 'use-context', clusterName]);
      await runCommand('kubectl', ['get', 'ns', '--request-timeout=15s']);
      return;
    }
    throw originalError;
  }
}

async function saveManifest(manifest) {
  ensureManifestDefaults(manifest);
  await writeJson(manifest.paths.manifestPath, manifest);
  await writeRunReport(manifest).catch(() => null);
}

function ensureManifestDefaults(manifest) {
  manifest.version = Math.max(Number(manifest.version || 0), 2);
  manifest.paths = manifest.paths || {};
  if (manifest.paths.runDir && !manifest.paths.reportPath) {
    manifest.paths.reportPath = path.join(manifest.paths.runDir, 'final-report.json');
  }
  manifest.request = manifest.request || {};
  manifest.resources = manifest.resources || {};
  manifest.resources.platformImages = Array.isArray(manifest.resources.platformImages)
    ? manifest.resources.platformImages
    : [];
  manifest.cleanup = manifest.cleanup || {};
  manifest.status = manifest.status || {};
  manifest.stages = manifest.stages || {};
  return manifest;
}

function serializeError(error) {
  if (!error) return { message: 'Unknown error' };
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
    code: error?.code || null
  };
}

function summarizeStageResult(result) {
  if (result === undefined) return null;
  if (result === null) return null;
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    return result;
  }
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return String(result);
  }
}

function stageRecord(manifest, stageName) {
  return manifest?.stages?.[stageName] || null;
}

function stageCompleted(manifest, stageName) {
  return stageRecord(manifest, stageName)?.status === 'completed';
}

async function markStage(manifest, stageName, patch) {
  const current = stageRecord(manifest, stageName) || {};
  manifest.stages[stageName] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveManifest(manifest);
  return manifest.stages[stageName];
}

async function skipStage(manifest, stageName, reason = '') {
  return markStage(manifest, stageName, {
    status: 'skipped',
    skippedAt: new Date().toISOString(),
    reason: reason || null
  });
}

async function runStage(manifest, stageName, work, { skipIfComplete = true, details = {} } = {}) {
  if (skipIfComplete && stageCompleted(manifest, stageName)) {
    return stageRecord(manifest, stageName)?.result ?? null;
  }
  const current = stageRecord(manifest, stageName) || {};
  await markStage(manifest, stageName, {
    status: 'running',
    startedAt: current.startedAt || new Date().toISOString(),
    completedAt: null,
    failedAt: null,
    error: null,
    attempts: Number(current.attempts || 0) + 1,
    details: {
      ...(current.details || {}),
      ...(details || {})
    }
  });
  try {
    const result = await work();
    await markStage(manifest, stageName, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      error: null,
      result: summarizeStageResult(result)
    });
    return result;
  } catch (error) {
    await markStage(manifest, stageName, {
      status: 'failed',
      failedAt: new Date().toISOString(),
      error: serializeError(error)
    });
    throw error;
  }
}

function stageFailed(manifest) {
  return Object.values(manifest?.stages || {}).find((stage) => stage?.status === 'failed') || null;
}

function cleanupHasErrors(manifest) {
  return Array.isArray(manifest?.cleanup?.errors) && manifest.cleanup.errors.length > 0;
}

function cleanupCompletedCleanly(manifest) {
  const publish = manifest?.status?.publish || null;
  const pushVerified = !publish || publish.skipPush || Boolean(publish.remoteVerifiedAt);
  return Boolean(manifest?.cleanup?.completedAt) && !cleanupHasErrors(manifest) && pushVerified;
}

function shouldRunCleanupStage(manifest, primaryError = null) {
  if (primaryError) return true;
  return !cleanupCompletedCleanly(manifest);
}

function syncCleanupStage(manifest) {
  if (!cleanupCompletedCleanly(manifest)) return false;
  const current = stageRecord(manifest, 'cleanup') || {};
  if (current.status === 'completed') return false;
  manifest.stages.cleanup = {
    ...current,
    status: 'completed',
    completedAt: manifest.cleanup.completedAt,
    failedAt: null,
    error: null,
    result: summarizeStageResult(manifest.cleanup),
    updatedAt: new Date().toISOString()
  };
  return true;
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
  const projectDomain = String(baseMetadata.PROJECT_HOST_DOMAIN || '').trim() || baseRootHost;
  const platformNamespace = `vibes-task-${taskSlug}`;
  return {
    slug: taskSlug,
    featureBranch,
    schema: schemaNameFromSlug(taskSlug),
    hosts: {
      root: `task-${taskSlug}.${projectDomain}`,
      app: `app-${taskSlug}.${projectDomain}`,
      api: `api-${taskSlug}.${projectDomain}`,
      projectDomain,
      projectSuffix: taskSlug,
      wildcardHosts: projectDomain
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
  let checkoutRef = `origin/${baseBranch}`;
  try {
    await runCommand('git', ['rev-parse', '--verify', checkoutRef], { cwd: cloneDir });
  } catch {
    checkoutRef = await gitOutput(sourceRepoRoot, ['rev-parse', '--verify', baseBranch]).catch(async () => {
      return gitOutput(sourceRepoRoot, ['rev-parse', '--verify', 'HEAD']);
    });
  }
  await runCommand('git', ['checkout', '-B', baseBranch, checkoutRef], { cwd: cloneDir });
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

function agentTaskGuardEnv(manifest) {
  return {
    AGENT_TASK_STRICT: 'true',
    AGENT_TASK_EXPECTED_PLATFORM_NAMESPACE: manifest.task.namespaces.platform,
    AGENT_TASK_EXPECTED_PLATFORM_SERVER_NAME: manifest.task.workloads.server,
    AGENT_TASK_EXPECTED_PLATFORM_WEB_NAME: manifest.task.workloads.web,
    AGENT_TASK_EXPECTED_PLATFORM_WORKER_NAME: manifest.task.workloads.worker,
    AGENT_TASK_EXPECTED_PLATFORM_REDIS_NAME: manifest.task.workloads.redis,
    AGENT_TASK_EXPECTED_ROOT_HOST: manifest.task.hosts.root,
    AGENT_TASK_EXPECTED_APP_HOST: manifest.task.hosts.app,
    AGENT_TASK_EXPECTED_API_HOST: manifest.task.hosts.api
  };
}

function dbParts(databaseUrl) {
  const url = new URL(String(databaseUrl || ''));
  return {
    host: url.hostname,
    port: String(url.port || 5432),
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: String(url.pathname || '').replace(/^\//, '') || 'postgres'
  };
}

function roleNameFromArn(roleArn) {
  return String(roleArn || '').trim().split('/').pop() || '';
}

function cloneJson(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function assumeRoleWebIdentityStatement(policyDocument) {
  const statements = Array.isArray(policyDocument?.Statement)
    ? policyDocument.Statement
    : policyDocument?.Statement
      ? [policyDocument.Statement]
      : [];
  return statements.find((statement) => {
    const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action];
    return actions.includes('sts:AssumeRoleWithWebIdentity');
  }) || null;
}

function subjectConditionRef(statement) {
  for (const conditionType of ['StringEquals', 'StringLike']) {
    const conditionBlock = statement?.Condition?.[conditionType];
    if (!conditionBlock || typeof conditionBlock !== 'object') continue;
    for (const [key, value] of Object.entries(conditionBlock)) {
      if (key.endsWith(':sub')) {
        return { conditionType, key, value };
      }
    }
  }
  return null;
}

async function ensureWorkerIrsaTrust(manifest) {
  const roleArn = String(manifest.cluster?.workerIrsaRoleArn || '').trim();
  const roleName = roleNameFromArn(roleArn);
  if (!roleName) return;
  const workerSubject = `system:serviceaccount:${manifest.task.namespaces.platform}:${manifest.task.workloads.workerServiceAccount}`;

  const { stdout } = await runCommand('aws', [
    'iam',
    'get-role',
    '--role-name',
    roleName,
    '--query',
    'Role.AssumeRolePolicyDocument',
    '--output',
    'json'
  ]);
  const originalPolicy = JSON.parse(stdout || '{}');
  const nextPolicy = cloneJson(originalPolicy);
  const statement = assumeRoleWebIdentityStatement(nextPolicy);
  if (!statement) {
    throw new Error(`Unable to find sts:AssumeRoleWithWebIdentity statement for ${roleName}`);
  }
  const subjectRef = subjectConditionRef(statement);
  if (!subjectRef) {
    throw new Error(`Unable to find OIDC subject condition for ${roleName}`);
  }

  const subjects = Array.isArray(subjectRef.value) ? subjectRef.value.slice() : [subjectRef.value].filter(Boolean);
  if (subjects.includes(workerSubject)) {
    manifest.resources.workerIrsaTrust = {
      roleName,
      workerSubject,
      adjusted: false
    };
    await saveManifest(manifest);
    return;
  }

  statement.Condition[subjectRef.conditionType][subjectRef.key] = [...subjects, workerSubject];
  await runCommand('aws', [
    'iam',
    'update-assume-role-policy',
    '--role-name',
    roleName,
    '--policy-document',
    JSON.stringify(nextPolicy)
  ]);
  manifest.resources.workerIrsaTrust = {
    roleName,
    workerSubject,
    adjusted: true,
    originalPolicy
  };
  await saveManifest(manifest);
}

async function restoreWorkerIrsaTrust(manifest) {
  const trustPatch = manifest.resources?.workerIrsaTrust;
  if (!trustPatch?.adjusted || !trustPatch.roleName || !trustPatch.originalPolicy) return;
  await runCommand('aws', [
    'iam',
    'update-assume-role-policy',
    '--role-name',
    trustPatch.roleName,
    '--policy-document',
    JSON.stringify(trustPatch.originalPolicy)
  ]);
  manifest.cleanup.workerIrsaTrust = {
    restoredAt: new Date().toISOString(),
    roleName: trustPatch.roleName
  };
  await saveManifest(manifest);
}

async function runSqlThroughCluster(manifest, databaseUrl, sql, { namespace = '' } = {}) {
  const kubeNamespace = namespace || manifest.cluster?.sharedPlatformNamespace || 'vibes-platform';
  const parts = dbParts(databaseUrl);
  const podName = `agent-task-db-${manifest.task?.slug || 'task'}-${shortRandom(4)}`;
  await runCommand('sh', [
    '-lc',
    `kubectl create namespace ${shellQuote(kubeNamespace)} --dry-run=client -o yaml | kubectl apply -f -`
  ]);
  try {
    await runCommand('sh', [
      '-lc',
      [
        `kubectl -n ${shellQuote(kubeNamespace)} run ${shellQuote(podName)}`,
        '--image=postgres:16',
        '--restart=Never',
        `--env=PGHOST=${shellQuote(parts.host)}`,
        `--env=PGPORT=${shellQuote(parts.port)}`,
        `--env=PGUSER=${shellQuote(parts.user)}`,
        `--env=PGPASSWORD=${shellQuote(parts.password)}`,
        '--env=PGSSLMODE=require',
        '--dry-run=client -o yaml --command -- sleep 600',
        '| kubectl apply -f -'
      ].join(' ')
    ]);
    await runCommand('kubectl', ['-n', kubeNamespace, 'wait', '--for=condition=Ready', `pod/${podName}`, '--timeout=180s']);
    await runCommand('kubectl', [
      '-n',
      kubeNamespace,
      'exec',
      podName,
      '--',
      'sh',
      '-lc',
      `psql -v ON_ERROR_STOP=1 -d ${shellQuote(parts.database)} <<'SQL'\n${sql}\nSQL`
    ]);
  } finally {
    await runCommand('kubectl', [
      '-n',
      kubeNamespace,
      'delete',
      'pod',
      podName,
      '--ignore-not-found',
      '--wait=false',
      '--grace-period=0',
      '--force'
    ]).catch(() => null);
  }
}

async function createSchema(manifest, databaseUrl, schema) {
  await runSqlThroughCluster(
    manifest,
    databaseUrl,
    `create schema if not exists ${quoteIdent(schema)} authorization current_user;`,
    { namespace: manifest.cluster?.sharedPlatformNamespace }
  );
}

async function dropSchema(manifest, databaseUrl, schema) {
  await runSqlThroughCluster(
    manifest,
    databaseUrl,
    `drop schema if exists ${quoteIdent(schema)} cascade;`,
    { namespace: manifest.cluster?.sharedPlatformNamespace }
  );
}

async function deleteValidationUser(manifest, databaseUrl, schema, email) {
  if (!email) return;
  const escapedEmail = String(email).replace(/'/g, "''");
  await runSqlThroughCluster(
    manifest,
    databaseUrl,
    `set search_path to ${quoteIdent(schema)}, public;\ndelete from users where email = '${escapedEmail}';`,
    { namespace: manifest.cluster?.sharedPlatformNamespace }
  );
}

async function dropDatabases(manifest, adminUrl, databases = []) {
  if (!databases.length) return;
  for (const database of databases) {
    if (!database) continue;
    try {
      await runSqlThroughCluster(
        manifest,
        adminUrl,
        `drop database if exists ${quoteIdent(database)} with (force);`,
        { namespace: manifest.cluster?.sharedPlatformNamespace }
      );
    } catch {
      await runSqlThroughCluster(
        manifest,
        adminUrl,
        `drop database if exists ${quoteIdent(database)};`,
        { namespace: manifest.cluster?.sharedPlatformNamespace }
      ).catch(() => null);
    }
  }
}

async function waitForDeploymentAvailable(namespace, deploymentName, timeout = '15m') {
  await runCommand('kubectl', [
    '-n',
    namespace,
    'wait',
    '--for=condition=Available',
    `deployment/${deploymentName}`,
    `--timeout=${timeout}`
  ]);
}

async function waitForTaskPlatformReady(manifest, phase) {
  const namespace = manifest.task?.namespaces?.platform;
  if (!namespace) return;
  await waitForDeploymentAvailable(namespace, manifest.task.workloads.redis, '10m');
  await waitForDeploymentAvailable(namespace, manifest.task.workloads.server, '15m');
  await waitForDeploymentAvailable(namespace, manifest.task.workloads.web, '15m');
  await waitForDeploymentAvailable(namespace, manifest.task.workloads.worker, '15m');
  manifest.status.platformReady = {
    ...(manifest.status.platformReady || {}),
    [phase]: new Date().toISOString()
  };
  await saveManifest(manifest);
}

async function schedulablePlatformNodeCount() {
  const { stdout } = await runCommand('kubectl', ['get', 'nodes', '-o', 'json']);
  const payload = JSON.parse(stdout || '{}');
  const nodes = Array.isArray(payload?.items) ? payload.items : [];
  return nodes.filter((node) => {
    const readyCondition = Array.isArray(node?.status?.conditions)
      ? node.status.conditions.find((condition) => condition.type === 'Ready')
      : null;
    if (readyCondition?.status !== 'True') return false;
    const taints = Array.isArray(node?.spec?.taints) ? node.spec.taints : [];
    return !taints.some((taint) => taint.effect === 'NoSchedule');
  }).length;
}

async function ensurePlatformNodegroupCapacity(manifest) {
  const clusterName = String(manifest.cluster?.name || '').trim();
  const region = String(manifest.task?.awsRegion || '').trim();
  if (!clusterName || !region) return;

  const { stdout } = await runCommand('aws', [
    'eks',
    'describe-nodegroup',
    '--cluster-name',
    clusterName,
    '--nodegroup-name',
    PLATFORM_NODEGROUP_NAME,
    '--region',
    region
  ]);
  const payload = JSON.parse(stdout || '{}');
  const scalingConfig = payload?.nodegroup?.scalingConfig || {};
  const currentScaling = {
    minSize: Number(scalingConfig.minSize || 0),
    maxSize: Number(scalingConfig.maxSize || 0),
    desiredSize: Number(scalingConfig.desiredSize || 0)
  };

  manifest.resources.platformNodegroupScaling = manifest.resources.platformNodegroupScaling || {
    clusterName,
    region,
    nodegroupName: PLATFORM_NODEGROUP_NAME,
    previousScalingConfig: currentScaling,
    adjusted: false
  };
  await saveManifest(manifest);

  const nextScaling = {
    minSize: currentScaling.minSize,
    maxSize: Math.max(currentScaling.maxSize, MIN_PLATFORM_NODE_COUNT),
    desiredSize: Math.max(currentScaling.desiredSize, MIN_PLATFORM_NODE_COUNT)
  };

  const needsUpdate =
    nextScaling.maxSize !== currentScaling.maxSize || nextScaling.desiredSize !== currentScaling.desiredSize;
  if (needsUpdate) {
    await runCommand('aws', [
      'eks',
      'update-nodegroup-config',
      '--cluster-name',
      clusterName,
      '--nodegroup-name',
      PLATFORM_NODEGROUP_NAME,
      '--region',
      region,
      '--scaling-config',
      `minSize=${nextScaling.minSize},maxSize=${nextScaling.maxSize},desiredSize=${nextScaling.desiredSize}`
    ]);
    manifest.resources.platformNodegroupScaling.adjusted = true;
    manifest.resources.platformNodegroupScaling.appliedScalingConfig = nextScaling;
    await saveManifest(manifest);
  }

  await waitFor(
    async () => (await schedulablePlatformNodeCount()) >= MIN_PLATFORM_NODE_COUNT,
    { timeoutMs: 20 * 60 * 1000, intervalMs: 5000 }
  );
}

async function restorePlatformNodegroupCapacity(manifest) {
  const scaling = manifest.resources?.platformNodegroupScaling;
  if (!scaling?.adjusted || !scaling.previousScalingConfig) return;
  await runCommand('aws', [
    'eks',
    'update-nodegroup-config',
    '--cluster-name',
    scaling.clusterName,
    '--nodegroup-name',
    scaling.nodegroupName,
    '--region',
    scaling.region,
    '--scaling-config',
    [
      `minSize=${Number(scaling.previousScalingConfig.minSize || 0)}`,
      `maxSize=${Number(scaling.previousScalingConfig.maxSize || 0)}`,
      `desiredSize=${Number(scaling.previousScalingConfig.desiredSize || 0)}`
    ].join(',')
  ]);
  manifest.cleanup.platformNodegroupScaling = {
    restoredAt: new Date().toISOString(),
    scalingConfig: scaling.previousScalingConfig
  };
  await saveManifest(manifest);
}

async function prepareCodexHome(manifest) {
  const codexHome = path.join(manifest.paths.runDir, 'codex-home');
  const authSourcePath = path.join(process.env.HOME || '', '.codex', 'auth.json');
  if (!(await pathExists(authSourcePath))) {
    throw new Error(`Codex auth file not found at ${authSourcePath}`);
  }
  await removePath(codexHome);
  await ensureDir(codexHome);
  await fs.copyFile(authSourcePath, path.join(codexHome, 'auth.json'));
  await fs.writeFile(path.join(codexHome, 'config.toml'), '', 'utf8');
  return codexHome;
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

  const sourceGeneratedDir = path.join(repoRoot, 'deploy', '.generated', 'replica');
  const sourceFiles = ['server.env', 'web.env', 'worker.env', 'metadata.env'];
  const hasSourceGeneratedEnv = await Promise.all(
    sourceFiles.map((fileName) => pathExists(path.join(sourceGeneratedDir, fileName)))
  );
  if (hasSourceGeneratedEnv.every(Boolean)) {
    await Promise.all(
      sourceFiles.map((fileName) =>
        fs.copyFile(path.join(sourceGeneratedDir, fileName), path.join(generatedDir, fileName))
      )
    );
  } else {
    const syncEnv = {
      ...process.env,
      REPLICA_OUTPUT_DIR: generatedDir
    };
    await runCommand('node', ['./cluster-bootstrap/sync-secrets.mjs'], {
      cwd: repoRoot,
      env: syncEnv
    });
  }

  const baseMetadata = await readEnvFile(path.join(generatedDir, 'metadata.env'));
  const baseServerEnv = await readEnvFile(path.join(generatedDir, 'server.env'));
  const baseWebEnv = await readEnvFile(path.join(generatedDir, 'web.env'));
  const baseWorkerEnv = await readEnvFile(path.join(generatedDir, 'worker.env'));

  manifest.task = buildTaskContext(baseMetadata, manifest.repo.featureBranch, manifest.task.slug);
  manifest.cluster = {
    name: String(baseMetadata.CLUSTER_NAME || '').trim(),
    sharedPlatformNamespace: String(baseMetadata.PLATFORM_NAMESPACE || 'vibes-platform').trim() || 'vibes-platform',
    workerIrsaRoleArn: String(baseMetadata.WORKER_IRSA_ROLE_ARN || '').trim()
  };
  manifest.database = {
    baseDatabaseUrl: baseServerEnv.DATABASE_URL,
    taskDatabaseUrl: withSearchPath(baseServerEnv.DATABASE_URL, manifest.task.schema),
    customerAdminUrl: baseWorkerEnv.CUSTOMER_DB_ADMIN_URL
  };

  const taskServerEnv = {
    ...baseServerEnv,
    DATABASE_URL: withSearchPath(baseServerEnv.DATABASE_URL, manifest.task.schema),
    REDIS_HOST: manifest.task.workloads.redis,
    REDIS_PORT: String(baseServerEnv.REDIS_PORT || 6379),
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
    REDIS_HOST: manifest.task.workloads.redis,
    REDIS_PORT: String(baseWorkerEnv.REDIS_PORT || 6379),
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
    ...taskWebEnv,
    ...agentTaskGuardEnv(manifest)
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
  manifest.status.overlayReady = true;
  await saveManifest(manifest);

  await createSchema(manifest, manifest.database.baseDatabaseUrl, manifest.task.schema);
  manifest.resources.platformSchema = {
    schema: manifest.task.schema,
    created: true
  };
  await saveManifest(manifest);
}

async function writeTaskCommands(cloneDir, manifest) {
  const overlayDir = path.join(cloneDir, '.vp-task');
  const binDir = path.join(overlayDir, 'bin');
  await ensureDir(binDir);
  const runDir = manifest.paths.runDir;
  const generatedDir = manifest.paths.generatedDir;
  const generatedEnv = `REPLICA_OUTPUT_DIR=${shellQuote(generatedDir)}`;
  const guardEnv = agentTaskGuardEnv(manifest);
  const guardExports = Object.entries(guardEnv)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  const featureValidationCommand = String(manifest.request?.featureValidationCommand || '').trim();

  const scripts = {
    'await-platform': `#!/usr/bin/env sh
set -eu
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} wait --for=condition=Available deployment/${shellQuote(manifest.task.workloads.redis)} --timeout=10m
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} wait --for=condition=Available deployment/${shellQuote(manifest.task.workloads.server)} --timeout=15m
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} wait --for=condition=Available deployment/${shellQuote(manifest.task.workloads.web)} --timeout=15m
kubectl -n ${shellQuote(manifest.task.namespaces.platform)} wait --for=condition=Available deployment/${shellQuote(manifest.task.workloads.worker)} --timeout=15m
`,
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
${guardExports}
export REPLICA_IMAGE_TAG="task-${manifest.task.slug}-manual-$(date -u +%Y%m%d%H%M%S)"
./deploy/build-push.sh
./deploy/apply-platform.sh
./.vp-task/bin/await-platform
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
./.vp-task/bin/await-platform
node ./validation/run-replica-flow.mjs
echo "validation evidence: $dir"
`,
    'validate-feature': featureValidationCommand
      ? `#!/usr/bin/env sh
set -eu
cd ${shellQuote(manifest.repo.cloneDir)}
export ${generatedEnv}
export VALIDATION_METADATA_ENV_FILE=${shellQuote(path.join(generatedDir, 'metadata.env'))}
export AGENT_TASK_MANIFEST_PATH=${shellQuote(manifest.paths.manifestPath)}
export AGENT_TASK_RUN_DIR=${shellQuote(manifest.paths.runDir)}
${featureValidationCommand}
`
      : `#!/usr/bin/env sh
set -eu
echo "No feature validation command configured for this run."
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
    '- `./.vp-task/bin/await-platform` blocks until the task platform deployments are available.',
    '- `./.vp-task/bin/platform-urls` prints the task-scoped hosts.',
    '- `./.vp-task/bin/redeploy-platform` rebuilds and reapplies the task platform from this clone.',
    '- `./.vp-task/bin/validate-platform` runs the full user/project/task validation flow and writes evidence outside the clone.',
    '- `./.vp-task/bin/validate-feature` runs the optional feature-specific validation command for this run.',
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
    REPLICA_IMAGE_TAG: imageTagForPhase(manifest, phase),
    ...agentTaskGuardEnv(manifest)
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
  await waitForTaskPlatformReady(manifest, phase);
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
  const codexHome = await prepareCodexHome(manifest);
  try {
    const fullPrompt = await buildCodexPrompt(manifest, prompt);
    const mergedEnv = parseEnv(await fs.readFile(path.join(manifest.repo.cloneDir, '.env'), 'utf8'));
    const env = {
      ...process.env,
      ...mergedEnv,
      CODEX_HOME: codexHome
    };
    const args = [
      'exec',
      '--ephemeral',
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
  } finally {
    await removePath(codexHome).catch(() => null);
  }
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

async function readOptionalJsonFile(filePath) {
  if (!(await pathExists(filePath))) return null;
  return readJson(filePath).catch(() => null);
}

async function readOptionalTextFile(filePath) {
  if (!(await pathExists(filePath))) return '';
  return fs.readFile(filePath, 'utf8').catch(() => '');
}

function validationWarningsFromArtifacts({ summary, routeState, runtimeLogs, verifiedMatch, repoMarkerText }) {
  const warnings = [];
  if (!summary) {
    warnings.push('summary_missing');
    return warnings;
  }

  const task = summary?.task || {};
  const fullBuild = summary?.full_build || {};
  if (String(task.status || '').toLowerCase() !== 'completed') warnings.push('task_not_completed');
  if (!String(task.commit_hash || '').trim()) warnings.push('task_commit_missing');
  if (String(fullBuild.status || '').toLowerCase() !== 'live') warnings.push('full_build_not_live');
  if (!String(fullBuild.id || '').trim()) warnings.push('full_build_id_missing');
  if (String(fullBuild.ref_commit || '').trim() !== String(task.commit_hash || '').trim()) {
    warnings.push('full_build_commit_mismatch');
  }

  const development = routeState?.project?.environments?.development || null;
  if (!development) {
    warnings.push('verified_route_state_missing');
  } else {
    if (String(development.build_status || '').toLowerCase() !== 'live') warnings.push('verified_build_status_not_live');
    if (String(development.preview_mode || '').toLowerCase() !== 'verified') warnings.push('verified_preview_mode_missing');
    if (String(development.selected_mode || '').toLowerCase() !== 'verified') warnings.push('verified_selected_mode_missing');
    if (String(development.live_commit_sha || '').trim() !== String(task.commit_hash || '').trim()) {
      warnings.push('verified_live_commit_mismatch');
    }
    if (String(development.live_task_id || '') !== String(task.id || '')) warnings.push('verified_live_task_mismatch');
  }

  if (!String(verifiedMatch?.matched_in || '').trim()) warnings.push('verified_marker_missing');
  if (!String(repoMarkerText || '').trim()) warnings.push('repo_marker_missing');

  const runtimeLogBody = String(runtimeLogs?.body?.logs || '');
  if (!String(runtimeLogs?.body?.attempt_id || '').trim()) warnings.push('verified_runtime_attempt_missing');
  if (runtimeLogBody.includes('Workspace preview running')) warnings.push('verified_runtime_still_workspace_preview');

  return Array.from(new Set(warnings));
}

async function analyzeValidationArtifacts(manifest) {
  if (!manifest.validation?.lastEvidenceDir || !manifest.validation?.lastSummaryPath) {
    return {
      summary: null,
      routeState: null,
      runtimeLogs: null,
      verifiedMatch: null,
      repoMarkerText: '',
      warnings: []
    };
  }
  const evidenceDir = manifest.validation.lastEvidenceDir;
  const summary = await readOptionalJsonFile(manifest.validation.lastSummaryPath);
  const routeState = await readOptionalJsonFile(path.join(evidenceDir, '08-route-state.json'));
  const runtimeLogs = await readOptionalJsonFile(path.join(evidenceDir, '09-runtime-logs.json'));
  const verifiedMatch = await readOptionalJsonFile(path.join(evidenceDir, '08-verified-match.json'));
  const repoMarkerText = await readOptionalTextFile(path.join(evidenceDir, '10-repo-marker.txt'));
  const warnings = validationWarningsFromArtifacts({
    summary,
    routeState,
    runtimeLogs,
    verifiedMatch,
    repoMarkerText
  });
  return {
    summary,
    routeState,
    runtimeLogs,
    verifiedMatch,
    repoMarkerText,
    warnings
  };
}

async function assertValidationReadyForPublish(manifest) {
  const analysis = await analyzeValidationArtifacts(manifest);
  manifest.validation = {
    ...(manifest.validation || {}),
    checkedAt: new Date().toISOString(),
    warnings: analysis.warnings
  };
  await saveManifest(manifest);
  if (analysis.warnings.length) {
    throw new Error(`Validation warnings prevent publish: ${analysis.warnings.join(', ')}`);
  }
  return analysis.summary;
}

async function runFeatureValidation(manifest) {
  const command = String(manifest.request?.featureValidationCommand || '').trim();
  if (!command) return { skipped: true };
  const evidenceDir = path.join(manifest.paths.runDir, 'validation', 'feature');
  await ensureDir(evidenceDir);
  const mergedEnv = parseEnv(await fs.readFile(path.join(manifest.repo.cloneDir, '.env'), 'utf8'));
  await spawnLogged({
    cmd: 'sh',
    args: ['-lc', command],
    cwd: manifest.repo.cloneDir,
    env: {
      ...process.env,
      ...mergedEnv,
      REPLICA_OUTPUT_DIR: manifest.paths.generatedDir,
      VALIDATION_METADATA_ENV_FILE: path.join(manifest.paths.generatedDir, 'metadata.env'),
      AGENT_TASK_MANIFEST_PATH: manifest.paths.manifestPath,
      AGENT_TASK_RUN_DIR: manifest.paths.runDir,
      AGENT_TASK_VALIDATION_SUMMARY_PATH: manifest.validation?.lastSummaryPath || '',
      AGENT_TASK_VALIDATION_EVIDENCE_DIR: manifest.validation?.lastEvidenceDir || ''
    },
    stdoutPath: path.join(evidenceDir, 'feature-validation.stdout.log'),
    stderrPath: path.join(evidenceDir, 'feature-validation.stderr.log'),
    timeoutMs: 30 * 60 * 1000
  });
  manifest.featureValidation = {
    command,
    evidenceDir,
    stdoutPath: path.join(evidenceDir, 'feature-validation.stdout.log'),
    stderrPath: path.join(evidenceDir, 'feature-validation.stderr.log'),
    completedAt: new Date().toISOString()
  };
  await saveManifest(manifest);
  return manifest.featureValidation;
}

function overallRunStatus(manifest, validationAnalysis) {
  const failedStage = stageFailed(manifest);
  const publish = manifest.status?.publish || null;
  const cleanup = manifest.cleanup || {};
  const cleanupStage = stageRecord(manifest, 'cleanup');
  if (cleanupStage?.status === 'running') return 'cleaning_up';
  if (cleanup.completedAt) {
    if (cleanupHasErrors(manifest)) return 'failed';
    if (publish && !publish.skipPush && !publish.remoteVerifiedAt) return 'failed';
    if (failedStage) return 'failed';
    return publish?.skipPush ? 'completed_unpublished' : 'succeeded';
  }
  if (failedStage || manifest.status?.lastError) return 'failed';
  if (publish?.committedAt) return 'cleaning_up';
  if (validationAnalysis?.warnings?.length) return 'validation_warning';
  return 'running';
}

function nextActionForReport(status) {
  if (status === 'running') return 'Wait for the active run to finish or resume it if interrupted.';
  if (status === 'cleaning_up') return 'Wait for cleanup to complete or rerun cleanup from the manifest.';
  if (status === 'validation_warning') return 'Review validation evidence and rerun after fixing the warning conditions.';
  if (status === 'completed_unpublished') return 'Review the branch and push manually if desired.';
  if (status === 'failed') return 'Inspect final-report.json and the stage evidence, then resume or run cleanup.';
  return 'Review the pushed branch and preserved evidence.';
}

async function writeRunReport(manifest) {
  if (!manifest?.paths?.reportPath) return;
  const validationAnalysis = await analyzeValidationArtifacts(manifest);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    runId: manifest.runId,
    status: overallRunStatus(manifest, validationAnalysis),
    nextAction: nextActionForReport(overallRunStatus(manifest, validationAnalysis)),
    repo: manifest.repo,
    task: manifest.task,
    request: {
      model: manifest.request?.model || null,
      timeoutMinutes: manifest.request?.timeoutMinutes || null,
      skipPush: Boolean(manifest.request?.skipPush),
      skipCleanup: Boolean(manifest.request?.skipCleanup),
      keepClone: Boolean(manifest.request?.keepClone),
      featureValidationConfigured: Boolean(manifest.request?.featureValidationCommand)
    },
    stages: manifest.stages || {},
    publish: manifest.status?.publish || null,
    validation: {
      lastLabel: manifest.validation?.lastLabel || null,
      evidenceDir: manifest.validation?.lastEvidenceDir || null,
      summaryPath: manifest.validation?.lastSummaryPath || null,
      checkedAt: manifest.validation?.checkedAt || null,
      warnings: validationAnalysis.warnings,
      summary: validationAnalysis.summary?.task
        ? {
            task: validationAnalysis.summary.task,
            full_build: validationAnalysis.summary.full_build
          }
        : null
    },
    featureValidation: manifest.featureValidation || null,
    cleanup: manifest.cleanup || {},
    paths: {
      manifestPath: manifest.paths.manifestPath,
      reportPath: manifest.paths.reportPath,
      runDir: manifest.paths.runDir,
      cloneDir: manifest.repo?.cloneDir || null
    },
    lastError: manifest.status?.lastError || null
  };
  await writeJson(manifest.paths.reportPath, report);
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
  await dropDatabases(manifest, manifest.database.customerAdminUrl, databaseNames);
  const validationUserEmail = summary?.user?.email || '';
  await deleteValidationUser(manifest, manifest.database.baseDatabaseUrl, manifest.task.schema, validationUserEmail);
  manifest.cleanup.validation = {
    completedAt: new Date().toISOString(),
    projectId: summary?.project?.id || null,
    userEmail: validationUserEmail || null,
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

async function verifyRemoteBranch(manifest, expectedCommit) {
  const cloneDir = manifest.repo.cloneDir;
  const output = await gitOutput(cloneDir, ['ls-remote', '--heads', 'origin', manifest.repo.featureBranch]);
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) {
    throw new Error(`Remote branch ${manifest.repo.featureBranch} was not found on origin after push`);
  }
  const [remoteCommit, remoteRef] = line.split(/\s+/, 2);
  if (!remoteCommit || remoteCommit !== expectedCommit) {
    throw new Error(
      `Remote branch ${manifest.repo.featureBranch} points to ${remoteCommit || 'unknown'}, expected ${expectedCommit}`
    );
  }
  return {
    remoteCommit,
    remoteRef: remoteRef || `refs/heads/${manifest.repo.featureBranch}`,
    remoteVerifiedAt: new Date().toISOString()
  };
}

async function commitAndPush(manifest, commitMessage, skipPush) {
  const cloneDir = manifest.repo.cloneDir;
  await runCommand('git', ['add', '-A'], { cwd: cloneDir });
  const status = await gitOutput(cloneDir, ['status', '--porcelain']);
  if (!status.trim()) {
    throw new Error('No tracked changes remain after sanitation; nothing to commit');
  }
  await runCommand('git', ['commit', '-m', commitMessage], { cwd: cloneDir });
  const commitHash = await gitOutput(cloneDir, ['rev-parse', 'HEAD']);
  if (!skipPush) {
    await runCommand('git', ['push', '-u', 'origin', `HEAD:${manifest.repo.featureBranch}`], { cwd: cloneDir });
  }
  const remoteVerification = skipPush ? null : await verifyRemoteBranch(manifest, commitHash);
  manifest.status.publish = {
    committedAt: new Date().toISOString(),
    skipPush: Boolean(skipPush),
    commitHash,
    remoteRef: remoteVerification?.remoteRef || null,
    remoteCommit: remoteVerification?.remoteCommit || null,
    remoteVerifiedAt: remoteVerification?.remoteVerifiedAt || null
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
  if (!manifest.task?.awsRegion) return;
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
  if (!manifest.task?.namespaces) return;
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
  let effectiveKeepClone = Boolean(keepClone);
  try {
    await cleanupValidation(manifest);
  } catch (error) {
    errors.push(`validation cleanup: ${error.message}`);
  }
  if (manifest.status?.overlayReady && manifest.task?.namespaces?.platform) {
    if (manifest.repo?.cloneDir && await pathExists(manifest.repo.cloneDir)) {
      try {
        await spawnLogged({
          cmd: 'sh',
          args: ['./deploy/destroy-platform.sh'],
          cwd: manifest.repo.cloneDir,
          env: {
            ...process.env,
            REPLICA_OUTPUT_DIR: manifest.paths.generatedDir,
            ...agentTaskGuardEnv(manifest),
            DELETE_PLATFORM_CLUSTER_ROLES: 'false',
            SKIP_REPLICA_KUBECONFIG_UPDATE: 'true'
          },
          stdoutPath: path.join(manifest.paths.runDir, 'cleanup', 'destroy.stdout.log'),
          stderrPath: path.join(manifest.paths.runDir, 'cleanup', 'destroy.stderr.log'),
          timeoutMs: 30 * 60 * 1000
        });
      } catch (error) {
        errors.push(`destroy-platform: ${error.message}`);
      }
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
    if (manifest.database?.baseDatabaseUrl && manifest.task?.schema) {
      try {
        await dropSchema(manifest, manifest.database.baseDatabaseUrl, manifest.task.schema);
      } catch (error) {
        errors.push(`schema cleanup: ${error.message}`);
      }
    }
  }
  try {
    await restoreWorkerIrsaTrust(manifest);
  } catch (error) {
    errors.push(`worker irsa restore: ${error.message}`);
  }
  try {
    await restorePlatformNodegroupCapacity(manifest);
  } catch (error) {
    errors.push(`platform nodegroup restore: ${error.message}`);
  }
  if (manifest.status?.publish && !manifest.status.publish.skipPush && !manifest.status.publish.remoteVerifiedAt) {
    errors.push('clone retained because push verification is missing');
    effectiveKeepClone = true;
  }
  if (errors.length > 0) {
    effectiveKeepClone = true;
  }
  if (!effectiveKeepClone) {
    await removePath(manifest.repo.cloneDir);
  }
  manifest.cleanup = {
    ...(manifest.cleanup || {}),
    completedAt: new Date().toISOString(),
    keepClone: effectiveKeepClone,
    errors
  };
  await saveManifest(manifest);
  if (errors.length) {
    throw new Error(`Cleanup completed with errors: ${errors.join(' | ')}`);
  }
}

function resolveRequestedBoolean(argsValue, storedValue = false) {
  if (argsValue === undefined) return Boolean(storedValue);
  return Boolean(argsValue);
}

function resolveRunOptions(manifest, args = {}) {
  return {
    prompt: String(manifest.request?.prompt || ''),
    commitMessage: String(args.commitMessage || manifest.request?.commitMessage || `feat: ${manifest.repo.featureBranch}`),
    model: String(args.model || manifest.request?.model || 'gpt-5.4'),
    timeoutMs: Math.max(
      15,
      Number(args.timeoutMinutes || manifest.request?.timeoutMinutes || 120)
    ) * 60 * 1000,
    skipPush: resolveRequestedBoolean(args.skipPush, manifest.request?.skipPush),
    skipCleanup: resolveRequestedBoolean(args.skipCleanup, manifest.request?.skipCleanup),
    keepClone: resolveRequestedBoolean(args.keepClone, manifest.request?.keepClone),
    featureValidationCommand: String(manifest.request?.featureValidationCommand || '')
  };
}

async function createRunManifest(args) {
  const baseBranch = String(args.base || 'main');
  const featureBranch = requiredArg(args, 'branch');
  const prompt = await readPrompt(args);
  const featureValidationCommand = await readFeatureValidationCommand(args);
  const runId = String(args.runId || `${timestampSlug()}-${shortRandom(6)}`);
  const runDir = path.join(repoRoot, 'validation', 'evidence', 'agent-cli', runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (await pathExists(manifestPath)) {
    throw new Error(`Run ${runId} already exists at ${manifestPath}; use resume instead of run`);
  }
  const taskSlug = deriveTaskSlug(featureBranch, args.taskSlug, runId);
  const cloneDir = path.join(runDir, 'clone');
  const generatedDir = path.join(runDir, 'generated', 'replica');
  await ensureDir(runDir);

  const manifest = {
    version: 2,
    runId,
    createdAt: new Date().toISOString(),
    request: {
      prompt,
      commitMessage: String(args.commitMessage || `feat: ${featureBranch}`),
      model: String(args.model || 'gpt-5.4'),
      timeoutMinutes: Math.max(15, Number(args.timeoutMinutes || 120)),
      skipPush: Boolean(args.skipPush),
      skipCleanup: Boolean(args.skipCleanup),
      keepClone: Boolean(args.keepClone),
      featureValidationCommand
    },
    repo: {
      sourceRoot: repoRoot,
      originUrl: await gitOutput(repoRoot, ['remote', 'get-url', 'origin']),
      baseBranch,
      featureBranch,
      cloneDir
    },
    paths: {
      runDir,
      manifestPath,
      reportPath: path.join(runDir, 'final-report.json'),
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
    status: {},
    stages: {}
  };
  ensureManifestDefaults(manifest);
  await saveManifest(manifest);
  return manifest;
}

async function loadManifestForResume(manifestPath) {
  const manifest = await readJson(path.resolve(manifestPath));
  ensureManifestDefaults(manifest);
  syncCleanupStage(manifest);
  await saveManifest(manifest);
  return manifest;
}

async function executeRun(manifest, args = {}) {
  ensureManifestDefaults(manifest);
  const options = resolveRunOptions(manifest, args);
  if (!options.prompt) {
    throw new Error('Manifest is missing the stored prompt needed to resume this run');
  }

  let primaryError = null;
  try {
    await runStage(
      manifest,
      'clone',
      async () => {
        if (await pathExists(path.join(manifest.repo.cloneDir, '.git'))) {
          return { reused: true };
        }
        await createClone({
          sourceRepoRoot: repoRoot,
          originUrl: manifest.repo.originUrl,
          cloneDir: manifest.repo.cloneDir,
          baseBranch: manifest.repo.baseBranch,
          featureBranch: manifest.repo.featureBranch
        });
        return { reused: false };
      },
      {
        details: {
          baseBranch: manifest.repo.baseBranch,
          featureBranch: manifest.repo.featureBranch
        }
      }
    );

    await runStage(manifest, 'overlay', async () => {
      await buildTaskOverlay(manifest);
      return { generatedDir: manifest.paths.generatedDir };
    });

    await runStage(manifest, 'platform-capacity', async () => {
      await ensurePlatformNodegroupCapacity(manifest);
      return manifest.resources.platformNodegroupScaling || {};
    });

    await runStage(manifest, 'worker-irsa-trust', async () => {
      await ensureWorkerIrsaTrust(manifest);
      return manifest.resources.workerIrsaTrust || {};
    });

    await runStage(manifest, 'deploy-pre-codex', async () => {
      await deployPlatform(manifest, 'pre-codex');
      return manifest.status.lastDeploy || {};
    });

    await runStage(
      manifest,
      'codex',
      async () => {
        await runCodex(manifest, options.prompt, options.model, options.timeoutMs);
        return manifest.status.codex || {};
      },
      {
        details: {
          model: options.model,
          timeoutMs: options.timeoutMs
        }
      }
    );

    await runStage(manifest, 'deploy-post-codex', async () => {
      await deployPlatform(manifest, 'post-codex');
      return manifest.status.lastDeploy || {};
    });

    await runStage(manifest, 'validation', async () => {
      const summary = await runValidation(manifest, 'post-codex');
      await assertValidationReadyForPublish(manifest);
      return {
        summaryPath: manifest.validation?.lastSummaryPath || null,
        task: summary?.task || null,
        fullBuild: summary?.full_build || null
      };
    });

    if (options.featureValidationCommand) {
      await runStage(manifest, 'feature-validation', async () => {
        return runFeatureValidation(manifest);
      });
    } else if (!stageRecord(manifest, 'feature-validation')) {
      await skipStage(manifest, 'feature-validation', 'No feature validation command configured');
    }

    await runStage(manifest, 'sanitize', async () => {
      await sanitizeClone(manifest);
      return { sanitizedAt: manifest.status.sanitizedAt || null };
    });

    await runStage(
      manifest,
      'publish',
      async () => {
        await commitAndPush(manifest, options.commitMessage, options.skipPush);
        return manifest.status.publish || {};
      },
      {
        details: {
          skipPush: options.skipPush
        }
      }
    );
  } catch (error) {
    primaryError = error;
    manifest.status.lastError = serializeError(error);
    manifest.status.failedAt = new Date().toISOString();
    await saveManifest(manifest);
  } finally {
    if (!options.skipCleanup && shouldRunCleanupStage(manifest, primaryError)) {
      try {
        await runStage(
          manifest,
          'cleanup',
          async () => {
            await cleanupManifest(manifest, { keepClone: options.keepClone });
            return manifest.cleanup;
          },
          { skipIfComplete: false, details: { keepClone: options.keepClone } }
        );
      } catch (cleanupError) {
        console.error(cleanupError.message);
        if (!primaryError) {
          primaryError = cleanupError;
        }
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }
}

async function runFlow(args) {
  await ensureKubeAccess();
  const manifest = await createRunManifest(args);
  await executeRun(manifest, args);
}

async function resumeFlow(args) {
  await ensureKubeAccess();
  const manifest = await loadManifestForResume(requiredArg(args, 'manifest'));
  await executeRun(manifest, args);
}

async function cleanupFlow(args) {
  const manifest = await loadManifestForResume(requiredArg(args, 'manifest'));
  await runStage(
    manifest,
    'cleanup',
    async () => {
      await cleanupManifest(manifest, { keepClone: Boolean(args.keepClone) });
      return manifest.cleanup;
    },
    { skipIfComplete: false, details: { keepClone: Boolean(args.keepClone) } }
  );
}

async function namespaceExists(namespace) {
  try {
    await runCommand('kubectl', ['get', 'namespace', namespace]);
    return true;
  } catch {
    return false;
  }
}

async function janitorReasons(manifest) {
  const reasons = [];
  if (!manifest.cleanup?.completedAt) reasons.push('cleanup_incomplete');
  if (Array.isArray(manifest.cleanup?.errors) && manifest.cleanup.errors.length) reasons.push('cleanup_errors');
  if (manifest.status?.publish && !manifest.status.publish.skipPush && !manifest.status.publish.remoteVerifiedAt) {
    reasons.push('push_unverified');
  }
  if (manifest.repo?.cloneDir && await pathExists(manifest.repo.cloneDir) && !manifest.cleanup?.keepClone) {
    reasons.push('clone_present');
  }
  for (const namespace of Object.values(manifest.task?.namespaces || {})) {
    if (await namespaceExists(namespace)) {
      reasons.push(`namespace_present:${namespace}`);
    }
  }
  return Array.from(new Set(reasons));
}

async function janitorFlow(args) {
  await ensureKubeAccess();
  const runsRoot = path.resolve(String(args.runsRoot || path.join(repoRoot, 'validation', 'evidence', 'agent-cli')));
  const olderThanHours = Math.max(0, Number(args.olderThanHours || 1));
  const olderThanMs = olderThanHours * 60 * 60 * 1000;
  const apply = Boolean(args.apply);
  const keepClone = Boolean(args.keepClone);
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(runsRoot, entry.name, 'manifest.json');
    if (!(await pathExists(manifestPath))) continue;
    const manifest = await loadManifestForResume(manifestPath);
    const createdAt = new Date(manifest.createdAt || 0).getTime();
    if (olderThanMs > 0 && createdAt && Date.now() - createdAt < olderThanMs) continue;
    const reasons = await janitorReasons(manifest);
    if (!reasons.length) continue;
    const candidate = {
      runId: manifest.runId,
      manifestPath,
      reasons,
      applied: false,
      error: null
    };
    if (apply) {
      try {
        await runStage(
          manifest,
          'cleanup',
          async () => {
            await cleanupManifest(manifest, { keepClone });
            return manifest.cleanup;
          },
          { skipIfComplete: false, details: { keepClone, janitor: true } }
        );
        candidate.applied = true;
      } catch (error) {
        candidate.error = serializeError(error);
      }
    }
    candidates.push(candidate);
  }

  const janitorDir = path.join(runsRoot, 'janitor');
  await ensureDir(janitorDir);
  const janitorReportPath = path.join(janitorDir, `${timestampSlug()}-${shortRandom(6)}.json`);
  await writeJson(janitorReportPath, {
    generatedAt: new Date().toISOString(),
    runsRoot,
    olderThanHours,
    apply,
    keepClone,
    candidates
  });
  console.log(`Janitor report: ${janitorReportPath}`);
  if (candidates.length) {
    console.log(JSON.stringify(candidates, null, 2));
  } else {
    console.log('No stale agent-task runs matched the janitor filter.');
  }
  if (apply && candidates.some((candidate) => candidate.error)) {
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'run';
  if (command === 'run') {
    await runFlow(args);
    return;
  }
  if (command === 'resume') {
    await resumeFlow(args);
    return;
  }
  if (command === 'cleanup') {
    await cleanupFlow(args);
    return;
  }
  if (command === 'janitor') {
    await janitorFlow(args);
    return;
  }
  usage();
  process.exitCode = 1;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export {
  buildTaskContext,
  cleanupCompletedCleanly,
  deriveTaskSlug,
  ensureManifestDefaults,
  overallRunStatus,
  parseArgs,
  agentTaskGuardEnv,
  shouldRunCleanupStage,
  validationWarningsFromArtifacts
};

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
