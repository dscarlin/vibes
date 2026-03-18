#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, pathExists, removePath, runCommand, spawnLogged } from '../agent-task/lib.mjs';
import { extractJsonPayload, repoRoot } from './lib.mjs';

let chatGptLoginChecked = false;

async function resolveCodexBinary() {
  const candidate = path.join(repoRoot, 'node_modules', '.bin', 'codex');
  if (await pathExists(candidate)) return candidate;
  return 'codex';
}

async function prepareCodexHome(baseDir) {
  const codexHome = path.join(baseDir, `codex-home-${Date.now()}`);
  await ensureDir(codexHome);
  return codexHome;
}

async function ensureChatGptLogin(binary) {
  if (chatGptLoginChecked) return;
  await runCommand(binary, ['login', 'status'], { cwd: repoRoot });
  chatGptLoginChecked = true;
}

function buildCodexEnv({ env = {}, authMode = 'chatgpt' }) {
  const merged = {
    ...process.env,
    ...env
  };
  if (String(authMode || 'chatgpt').trim().toLowerCase() === 'chatgpt') {
    delete merged.OPENAI_API_KEY;
  }
  return merged;
}

export async function runCodexText({
  cwd,
  prompt,
  model,
  outputDir,
  label,
  env = {},
  authMode = 'chatgpt',
  timeoutMs = 30 * 60 * 1000
}) {
  await ensureDir(outputDir);
  const binary = await resolveCodexBinary();
  const responsePath = path.join(outputDir, `${label}.response.txt`);
  const codexHome = await prepareCodexHome(outputDir);
  try {
    if (String(authMode || 'chatgpt').trim().toLowerCase() === 'chatgpt') {
      await ensureChatGptLogin(binary);
    }
    await spawnLogged({
      cmd: binary,
      args: [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--json',
        '-o',
        responsePath,
        '-m',
        model,
        '-c',
        'reasoning.effort="high"',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        cwd
      ],
      cwd,
      env: {
        ...buildCodexEnv({ env, authMode }),
        CODEX_HOME: codexHome
      },
      stdinText: prompt,
      stdoutPath: path.join(outputDir, `${label}.stdout.jsonl`),
      stderrPath: path.join(outputDir, `${label}.stderr.log`),
      timeoutMs
    });
    return fs.readFile(responsePath, 'utf8');
  } finally {
    await removePath(codexHome).catch(() => null);
  }
}

export async function runCodexJson(options) {
  const text = await runCodexText(options);
  return extractJsonPayload(text);
}
