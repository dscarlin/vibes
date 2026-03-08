import os from 'os';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import tar from 'tar';
import unzipper from 'unzipper';

const exec = promisify(execFile);

const AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'Vibes AI';
const AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'ai@vibes.local';
const SNAPSHOT_ARTIFACTS = new Set([
  'snapshot.tar.gz',
  'snapshot-updated.tar.gz',
  'deploy-snapshot.tar.gz'
]);
const SNAPSHOT_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'out',
  '.svelte-kit',
  '.astro',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage'
]);

function isSnapshotArtifact(entryPath) {
  if (!entryPath) return false;
  const normalized = entryPath.replace(/^\.\//, '');
  return SNAPSHOT_ARTIFACTS.has(normalized);
}

function isExcludedPath(entryPath) {
  if (!entryPath) return false;
  const normalized = entryPath.replace(/^\.\//, '');
  if (isSnapshotArtifact(normalized)) return true;
  const parts = normalized.split('/');
  return parts.some((part) => SNAPSHOT_EXCLUDE_DIRS.has(part));
}

async function runGit(args, cwd) {
  await exec('git', args, { cwd });
}

async function gitOutput(args, cwd) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

export async function extractArchive(buffer, ext) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'vibes-upload-'));
  const archivePath = path.join(tempDir, `upload${ext}`);
  await fsPromises.writeFile(archivePath, buffer);
  if (ext === '.zip') {
    await fs.createReadStream(archivePath).pipe(unzipper.Extract({ path: tempDir })).promise();
  } else if (ext === '.tar') {
    await tar.x({ file: archivePath, cwd: tempDir });
  } else {
    await tar.x({ file: archivePath, cwd: tempDir, gzip: true });
  }
  await fsPromises.rm(archivePath, { force: true });
  return tempDir;
}

export async function removeTempDir(dir) {
  if (!dir) return;
  try {
    await fsPromises.rm(dir, { recursive: true, force: true });
  } catch {}
}

export async function detectRepoRoot(extractDir) {
  try {
    await fsPromises.access(path.join(extractDir, '.git'));
    return extractDir;
  } catch {
    const entries = await fsPromises.readdir(extractDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 1) {
      return path.join(extractDir, dirs[0]);
    }
  }
  return extractDir;
}

export async function ensureGitRepo(repoPath) {
  try {
    await fsPromises.access(path.join(repoPath, '.git'));
  } catch {
    await runGit(['init'], repoPath);
    await runGit(['config', 'user.name', AUTHOR_NAME], repoPath);
    await runGit(['config', 'user.email', AUTHOR_EMAIL], repoPath);
    await runGit(['add', '.'], repoPath);
    await runGit(['commit', '-m', 'init'], repoPath);
  }
}

export async function validateRepo(repoPath) {
  const nodeModulesPath = path.join(repoPath, 'node_modules');
  try {
    const entries = await fsPromises.readdir(nodeModulesPath);
    if (entries.length > 0) {
      throw new Error('Upload rejected: node_modules detected');
    }
  } catch {}

  await runGit(['config', 'core.filemode', 'false'], repoPath);
  await runGit(['checkout', '-B', 'main'], repoPath);
  const mainStatus = await gitOutput(['status', '--porcelain'], repoPath);
  if (mainStatus) throw new Error(`Upload rejected: uncommitted changes on main:\n${mainStatus}`);

  const hasAiTask = await exec('git', ['show-ref', '--verify', 'refs/heads/ai-task'], { cwd: repoPath })
    .then(() => true)
    .catch(() => false);
  if (hasAiTask) {
    await runGit(['checkout', 'ai-task'], repoPath);
    const aiStatus = await gitOutput(['status', '--porcelain'], repoPath);
    if (aiStatus) throw new Error(`Upload rejected: uncommitted changes on ai-task:\n${aiStatus}`);
    await runGit(['checkout', 'main'], repoPath);
  }
}

export async function archiveRepo(repoPath) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'vibes-archive-'));
  const outPath = path.join(tempDir, 'snapshot.tar.gz');
  await tar.c(
    {
      gzip: true,
      file: outPath,
      cwd: repoPath,
      filter: (entryPath) => !isExcludedPath(entryPath)
    },
    ['.']
  );
  return fsPromises.readFile(outPath);
}
