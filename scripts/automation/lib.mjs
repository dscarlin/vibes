#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ensureDir,
  gitOutput,
  parseEnv,
  pathExists,
  readJson,
  repoRootFrom,
  runCommand,
  shortRandom,
  slugify,
  spawnLogged,
  timestampSlug,
  writeJson
} from '../agent-task/lib.mjs';

export const repoRoot = repoRootFrom(import.meta.url);

const DEFAULT_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.server',
  '.env.worker',
  '.env.automation',
  '.env.automation.local'
];

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      args._.push(arg);
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

export function parseCommaList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function loadAutomationEnv(extraEnv = process.env) {
  const merged = {};
  for (const relativePath of DEFAULT_ENV_FILES) {
    const filePath = path.join(repoRoot, relativePath);
    if (!(await pathExists(filePath))) continue;
    Object.assign(merged, parseEnv(await fs.readFile(filePath, 'utf8')));
  }
  return {
    ...merged,
    ...extraEnv
  };
}

export function buildStatusNames(env) {
  return {
    aiDrafted: String(env.AUTOMATION_STATUS_AI_DRAFTED || 'AI Drafted').trim(),
    readyForPlan: String(env.AUTOMATION_STATUS_READY_FOR_AI_PLAN || 'Ready for AI Plan').trim(),
    aiPlanGenerated: String(env.AUTOMATION_STATUS_AI_PLAN_GENERATED || 'AI Plan Generated').trim(),
    readyForBuild: String(env.AUTOMATION_STATUS_READY_FOR_AI_BUILD || 'Ready for AI Build').trim(),
    aiBuilding: String(env.AUTOMATION_STATUS_AI_BUILDING || 'AI Building').trim(),
    aiReviewReady: String(env.AUTOMATION_STATUS_AI_REVIEW_READY || 'AI Review Ready').trim(),
    aiBuildFailed: String(env.AUTOMATION_STATUS_AI_BUILD_FAILED || 'AI Build Failed').trim()
  };
}

export function automationConfig(env) {
  const aiWorkRoot = path.resolve(String(env.AIWORK_ROOT || path.join(repoRoot, 'AIWork')));
  return {
    aiWorkRoot,
    openAiApiKey: String(env.OPENAI_API_KEY || '').trim(),
    codexModel: String(env.AUTOMATION_CODEX_MODEL || env.OPENAI_MODEL || 'gpt-5.4').trim(),
    codexAuthMode: String(env.AUTOMATION_CODEX_AUTH_MODE || 'chatgpt').trim().toLowerCase() || 'chatgpt',
    transcriptionModel: String(env.OPENAI_AUDIO_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe').trim(),
    baseBranch: String(env.AUTOMATION_BASE_BRANCH || 'main').trim(),
    reviewEmailTo: parseCommaList(env.AUTOMATION_REVIEW_EMAIL_TO),
    reviewEmailCc: parseCommaList(env.AUTOMATION_REVIEW_EMAIL_CC),
    driveFolderId: String(env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
    googleUser: String(env.GOOGLE_GMAIL_USER || 'me').trim() || 'me',
    googleAccessToken: String(env.GOOGLE_ACCESS_TOKEN || '').trim(),
    googleClientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
    googleClientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
    googleRefreshToken: String(env.GOOGLE_REFRESH_TOKEN || '').trim(),
    jiraBaseUrl: String(env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
    jiraProjectKey: String(env.JIRA_PROJECT_KEY || '').trim(),
    jiraEmail: String(env.JIRA_EMAIL || '').trim(),
    jiraApiToken: String(env.JIRA_API_TOKEN || '').trim(),
    clusterValidationCommand: String(env.AUTOMATION_CLUSTER_VALIDATION_CMD || '').trim(),
    runAllAcceptedValidations: String(env.AUTOMATION_RUN_ALL_ACCEPTED_VALIDATIONS || 'true').trim() !== 'false',
    keepValidationEnv: String(env.AUTOMATION_KEEP_VALIDATION_ENV || '').trim() === 'true',
    statuses: buildStatusNames(env)
  };
}

export function assertConfig(config, requiredKeys) {
  const missing = requiredKeys.filter((key) => !String(config[key] || '').trim() && !(Array.isArray(config[key]) && config[key].length));
  if (missing.length) {
    throw new Error(`Missing automation config: ${missing.join(', ')}`);
  }
}

export function meetingDir(aiWorkRoot, meetingId) {
  return path.join(aiWorkRoot, 'meetings', meetingId);
}

export function jiraDir(aiWorkRoot, issueKey) {
  return path.join(aiWorkRoot, 'jira', issueKey);
}

export function runDir(aiWorkRoot, runId) {
  return path.join(aiWorkRoot, 'runs', runId);
}

export async function readJsonIfExists(filePath, fallback = null) {
  if (!(await pathExists(filePath))) return fallback;
  return readJson(filePath);
}

export async function readTextIfExists(filePath, fallback = '') {
  if (!(await pathExists(filePath))) return fallback;
  return fs.readFile(filePath, 'utf8');
}

export async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, 'utf8');
}

export function extractJsonPayload(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Codex returned an empty response');
  }
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  return JSON.parse(candidate);
}

export function renderReviewEmail(meeting, extractedItems) {
  const lines = [
    `Meeting candidate review for ${meeting.title || meeting.meetingId}`,
    '',
    `Meeting ID: ${meeting.meetingId}`,
    `Source file: ${meeting.source?.name || ''}`,
    `Generated at: ${meeting.generatedAt || new Date().toISOString()}`,
    ''
  ];
  for (const [index, item] of extractedItems.entries()) {
    lines.push(`${index + 1}. ${item.title || 'Untitled item'} [${item.type || 'candidate'}]`);
    lines.push(`Why: ${item.why_it_exists || item.whyItExists || ''}`);
    lines.push(`Value: ${item.user_business_value || item.userBusinessValue || ''}`);
    lines.push(`Implementation: ${item.tentative_implementation_summary || item.tentativeImplementationSummary || ''}`);
    lines.push(`Confidence: ${item.confidence || ''}`);
    if (item.ambiguity_notes || item.ambiguityNotes) {
      lines.push(`Ambiguity: ${item.ambiguity_notes || item.ambiguityNotes}`);
    }
    lines.push('');
  }
  lines.push('Reply with guidance on what should become Jira stories and any scope adjustments.');
  lines.push('The next automation stage will use this thread as the reviewed source of truth.');
  lines.push('');
  return lines.join('\n');
}

export function buildRunId(prefix = 'run') {
  return `${prefix}-${timestampSlug()}-${shortRandom(6)}`;
}

export function buildMeetingId(sourceName = 'meeting') {
  return `${slugify(sourceName, { maxLength: 20 })}-${timestampSlug()}-${shortRandom(4)}`;
}

export function buildRunBranchName(date = new Date(), label = '') {
  const isoDate = date.toISOString().slice(0, 10);
  const suffix = slugify(label || 'batch', { maxLength: 24 });
  return `ai/run/${isoDate}-${suffix}`;
}

export function buildIssueBranchName(issueKey, summary = '') {
  return `ai/issue/${String(issueKey || '').toUpperCase()}-${slugify(summary || issueKey, { maxLength: 24 })}`;
}

export function buildReconciledBranchName(issueKey, runId) {
  return `ai/reconciled/${String(issueKey || '').toUpperCase()}-${slugify(runId, { maxLength: 20 })}`;
}

export async function cloneWorkspace({ cloneDir, sourceRepoRoot = repoRoot, branch = '', originUrl = '' }) {
  await runCommand('git', ['clone', sourceRepoRoot, cloneDir], { cwd: sourceRepoRoot });
  if (originUrl) {
    await runCommand('git', ['remote', 'set-url', 'origin', originUrl], { cwd: cloneDir });
    await runCommand('git', ['fetch', 'origin', '--prune'], { cwd: cloneDir });
  }
  if (branch) {
    await runCommand('git', ['checkout', '-B', branch, `origin/${branch}`], { cwd: cloneDir }).catch(async () => {
      await runCommand('git', ['checkout', branch], { cwd: cloneDir });
    });
  }
}

export async function ensureWorkspaceBranch(cloneDir, branch) {
  await runCommand('git', ['fetch', 'origin', '--prune'], { cwd: cloneDir });
  await runCommand('git', ['checkout', '-B', branch, `origin/${branch}`], { cwd: cloneDir });
  await runCommand('git', ['reset', '--hard', `origin/${branch}`], { cwd: cloneDir });
  await runCommand('git', ['clean', '-fd'], { cwd: cloneDir });
}

export async function createRemoteBranch({ repoPath = repoRoot, localRef, remoteBranch }) {
  await runCommand('git', ['push', 'origin', `${localRef}:refs/heads/${remoteBranch}`], { cwd: repoPath });
}

export async function currentOriginUrl(repoPath = repoRoot) {
  return gitOutput(repoPath, ['remote', 'get-url', 'origin']);
}

export async function gitSha(repoPath, ref) {
  return gitOutput(repoPath, ['rev-parse', '--verify', ref]);
}

export async function writeManifest(filePath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await writeJson(filePath, manifest);
}

export async function runLoggedCommand({ cmd, args, cwd, env, stdoutPath, stderrPath, timeoutMs = 0 }) {
  await spawnLogged({
    cmd,
    args,
    cwd,
    env,
    stdoutPath,
    stderrPath,
    timeoutMs
  });
}

export async function findMeetingManifests(aiWorkRoot) {
  const meetingsRoot = path.join(aiWorkRoot, 'meetings');
  const entries = await fs.readdir(meetingsRoot, { withFileTypes: true }).catch(() => []);
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(meetingsRoot, entry.name, 'manifest.json');
    if (!(await pathExists(manifestPath))) continue;
    manifests.push(await readJson(manifestPath));
  }
  return manifests.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

export async function findMeetingByDriveId(aiWorkRoot, driveFileId) {
  const manifests = await findMeetingManifests(aiWorkRoot);
  return manifests.find((manifest) => manifest?.source?.driveFileId === driveFileId) || null;
}

export async function findRunManifests(aiWorkRoot) {
  const runsRoot = path.join(aiWorkRoot, 'runs');
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(runsRoot, entry.name, 'manifest.json');
    if (!(await pathExists(manifestPath))) continue;
    manifests.push(await readJson(manifestPath));
  }
  return manifests;
}
