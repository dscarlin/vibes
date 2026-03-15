import fs from 'fs/promises';
import path from 'path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';
const VIBES_DIR = path.join(WORKSPACE_ROOT, '.vibes');
const HEARTBEAT_PATH = path.join(VIBES_DIR, 'heartbeat');
const AGENT_PID_PATH = path.join(VIBES_DIR, 'agent.pid');
const INTERVAL_MS = Math.max(
  5000,
  Number(process.env.WORKSPACE_AGENT_HEARTBEAT_MS || process.env.WORKSPACE_HEARTBEAT_INTERVAL_MS || 15000)
);

let interval = null;
let stopped = false;

async function writeHeartbeat() {
  if (stopped) return;
  await fs.mkdir(VIBES_DIR, { recursive: true });
  await fs.writeFile(AGENT_PID_PATH, `${process.pid}\n`);
  await fs.writeFile(HEARTBEAT_PATH, `${new Date().toISOString()}\n`);
}

async function shutdown(signal) {
  stopped = true;
  if (interval) clearInterval(interval);
  try {
    await writeHeartbeat();
  } catch {}
  if (signal) process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await writeHeartbeat();
interval = setInterval(() => {
  writeHeartbeat().catch((err) => {
    console.error('workspace agent heartbeat failed', err?.message || err);
  });
}, INTERVAL_MS);

await new Promise(() => {});
