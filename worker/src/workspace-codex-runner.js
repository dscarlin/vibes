import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

function sanitizeCodexSummary(raw) {
  if (!raw) return '';
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .map((obj) => {
      if (!obj?.item) return '';
      if (obj.item.type === 'agent_message') return `${obj.item.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractCodexThreadId(raw) {
  if (!raw) return '';
  for (const line of raw.split('\n')) {
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

async function ensureCodexAuth() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  const authPath = path.join(process.env.HOME || '/root', '.codex', 'auth.json');
  try {
    await fsPromises.access(authPath);
    return;
  } catch {}
  try {
    await exec('sh', ['-lc', 'printenv OPENAI_API_KEY | codex login --with-api-key']);
  } catch (error) {
    const errStderr = error?.stderr || '';
    const errMessage = error?.message || '';
    console.log('Codex login failed:', errStderr || errMessage);
  }
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

async function main() {
  const cwd = path.resolve(process.argv[2] || process.cwd());
  const threadId = process.argv[3] || '';
  await ensureCodexAuth();
  const prompt = await readStdin();
  const wrappedPrompt = buildCodexPrompt(prompt, codexWrapperMode());
  const responseFilePath = path.join(cwd, '.codex-last-message.txt');
  const template = process.env.CODEX_COMMAND_TEMPLATE;
  const resumeTemplate = process.env.CODEX_COMMAND_TEMPLATE_RESUME;

  if (template) {
    const env = {
      ...process.env,
      CODEX_PROMPT: wrappedPrompt,
      CODEX_RESPONSE_FILE: responseFilePath,
      CODEX_THREAD_ID: threadId
    };
    try {
      const commandTemplate = threadId && resumeTemplate ? resumeTemplate : template;
      const { stdout, stderr } = await exec('sh', ['-lc', commandTemplate], { cwd, env });
      const stdoutText = stdout || '';
      process.stdout.write(
        JSON.stringify({
          success: true,
          output: `${sanitizeCodexSummary(stdoutText)}${stderr || ''}`,
          rawOutput: stdoutText,
          threadId: extractCodexThreadId(stdoutText)
        })
      );
      return;
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          success: false,
          output: `${error?.stdout || ''}${error?.stderr || error?.message || ''}`,
          rawOutput: error?.stdout || '',
          threadId: ''
        })
      );
      return;
    }
  }

  const command = process.env.CODEX_COMMAND || 'codex';
  const args = (process.env.CODEX_ARGS || '').split(' ').filter(Boolean);
  const promptFlag = process.env.CODEX_PROMPT_FLAG || '--prompt';
  const resumeSubcommand = process.env.CODEX_RESUME_SUBCOMMAND || 'resume';
  const execArgs = threadId
    ? [resumeSubcommand, threadId, ...args, promptFlag, wrappedPrompt]
    : [...args, promptFlag, wrappedPrompt];
  try {
    const { stdout, stderr } = await exec(command, execArgs, { cwd, env: process.env });
    process.stdout.write(
      JSON.stringify({
        success: true,
        output: `${stdout || ''}${stderr || ''}`,
        rawOutput: stdout || '',
        threadId: extractCodexThreadId(stdout || '')
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        output: `${error?.stdout || ''}${error?.stderr || error?.message || ''}`,
        rawOutput: error?.stdout || '',
        threadId: ''
      })
    );
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
