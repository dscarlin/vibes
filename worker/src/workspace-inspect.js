import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const repoPath = path.resolve(process.argv[2] || '/workspace/project');
const MAX_DEPTH = 3;
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vibes',
  'build',
  'coverage',
  'dist',
  'node_modules'
]);
const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  try {
    const data = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

async function walkPackageDirs(dirPath, depth = 0, relDir = '.') {
  const results = [];
  if (await fileExists(path.join(dirPath, 'package.json'))) {
    results.push({ dirPath, relDir });
  }
  if (depth >= MAX_DEPTH) return results;
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const childDir = path.join(dirPath, entry.name);
    const childRel = relDir === '.' ? entry.name : path.posix.join(relDir, entry.name);
    results.push(...await walkPackageDirs(childDir, depth + 1, childRel));
  }
  return results;
}

async function findNearestLockfile(startDir) {
  let current = startDir;
  while (true) {
    for (const name of LOCKFILE_NAMES) {
      const candidate = path.join(current, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    if (path.resolve(current) === path.resolve(repoPath)) return '';
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

function packageManagerForLockfile(lockfilePath, hasPackageJson) {
  if (lockfilePath.endsWith('pnpm-lock.yaml')) return 'pnpm';
  if (lockfilePath.endsWith('yarn.lock')) return 'yarn';
  if (lockfilePath.endsWith('bun.lockb') || lockfilePath.endsWith('bun.lock')) return 'bun';
  return hasPackageJson ? 'npm' : null;
}

function installCommandForManager(packageManager) {
  if (packageManager === 'pnpm') return 'corepack enable >/dev/null 2>&1 || true && pnpm install';
  if (packageManager === 'yarn') return 'corepack enable >/dev/null 2>&1 || true && yarn install';
  if (packageManager === 'bun') return 'bun install';
  return 'npm install --include=dev --no-audit --no-fund';
}

function runScriptCommand(packageManager, scriptName) {
  if (packageManager === 'pnpm') return `corepack enable >/dev/null 2>&1 || true && pnpm run ${scriptName}`;
  if (packageManager === 'yarn') return `corepack enable >/dev/null 2>&1 || true && yarn ${scriptName}`;
  if (packageManager === 'bun') return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function escapeShell(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function prefixedCommand(relDir, command) {
  if (!command) return '';
  if (!relDir || relDir === '.') return command;
  return `cd ${escapeShell(relDir)} && ${command}`;
}

function isolatedCommand(relDir, command) {
  if (!command) return '';
  if (!relDir || relDir === '.') return command;
  return `(cd ${escapeShell(relDir)} && ${command})`;
}

function parsePortFromScript(script) {
  const text = String(script || '');
  const patterns = [
    /(?:--port|-p)\s+(\d{2,5})/i,
    /PORT\s*=\s*(\d{2,5})/i,
    /localhost:(\d{2,5})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function dependencyNames(pkg) {
  return new Set([
    ...Object.keys(pkg?.dependencies || {}),
    ...Object.keys(pkg?.devDependencies || {}),
    ...Object.keys(pkg?.optionalDependencies || {})
  ]);
}

function hasInstallableDependencies(pkg) {
  return (
    Object.keys(pkg?.dependencies || {}).length > 0 ||
    Object.keys(pkg?.devDependencies || {}).length > 0 ||
    Object.keys(pkg?.optionalDependencies || {}).length > 0
  );
}

function inferPort(candidate, configPort) {
  if (configPort) return configPort;
  const scriptPort = parsePortFromScript(candidate.scriptCommand);
  if (scriptPort) return scriptPort;
  const deps = candidate.dependencySet;
  if (deps.has('astro')) return 4321;
  if (deps.has('vite') || deps.has('vitest') || deps.has('@sveltejs/kit')) return 5173;
  if (deps.has('parcel')) return 1234;
  if (deps.has('expo')) return 8081;
  return 3000;
}

function isFrontendCandidate(candidate) {
  const deps = candidate.dependencySet;
  return [
    'vite',
    'react',
    'next',
    'astro',
    'svelte',
    'vue',
    '@sveltejs/kit',
    'react-scripts'
  ].some((name) => deps.has(name));
}

function scoreCandidate(candidate, rootHasWorkspaces) {
  let score = 0;
  if (candidate.scriptName === 'dev') score += 120;
  if (candidate.scriptName === 'start') score += 50;
  if (candidate.relDir === '.') score += 25;
  if (candidate.relDir !== '.') score += Math.max(0, 18 - candidate.depth * 4);
  if (isFrontendCandidate(candidate)) score += 35;
  if (candidate.hmrCapable) score += 25;
  if (rootHasWorkspaces && candidate.relDir !== '.') score += 10;
  if (candidate.pkg?.private) score += 3;
  return score;
}

function workspaceAwareRunCommand(rootPackageManager, packageName, scriptName) {
  if (!packageName || !scriptName) return '';
  if (rootPackageManager === 'pnpm') return `corepack enable >/dev/null 2>&1 || true && pnpm --filter ${escapeShell(packageName)} run ${scriptName}`;
  if (rootPackageManager === 'yarn') return `corepack enable >/dev/null 2>&1 || true && yarn workspace ${escapeShell(packageName)} ${scriptName}`;
  if (rootPackageManager === 'npm') return `npm run ${scriptName} --workspace ${escapeShell(packageName)}`;
  return '';
}

async function detectStaticFullstackPreview(rootPkg) {
  const hasStartAll = await fileExists(path.join(repoPath, 'scripts', 'start-all.js'));
  if (!hasStartAll) return null;

  const webPkg = await readJson(path.join(repoPath, 'web', 'package.json'));
  const serverPkg = await readJson(path.join(repoPath, 'server', 'package.json'));
  if (!webPkg || !serverPkg) return null;

  const webDevScript = typeof webPkg?.scripts?.dev === 'string' ? webPkg.scripts.dev : '';
  const serverStartScript =
    typeof serverPkg?.scripts?.start === 'string'
      ? serverPkg.scripts.start
      : typeof serverPkg?.scripts?.dev === 'string'
        ? serverPkg.scripts.dev
        : '';

  if (!webDevScript || !serverStartScript) return null;

  const rootLockfile = (await findNearestLockfile(repoPath)) || path.join(repoPath, 'package-lock.json');
  const webLockfile = await findNearestLockfile(path.join(repoPath, 'web'));
  const serverLockfile = await findNearestLockfile(path.join(repoPath, 'server'));
  const rootPackageManager = packageManagerForLockfile(rootLockfile, Boolean(rootPkg)) || 'npm';
  const webPackageManager = packageManagerForLockfile(webLockfile, true) || 'npm';
  const serverPackageManager = packageManagerForLockfile(serverLockfile, true) || 'npm';
  const serverScriptName = serverPkg?.scripts?.start ? 'start' : 'dev';
  const serverCommand = isolatedCommand(
    'server',
    `PORT=3001 ${runScriptCommand(serverPackageManager, serverScriptName)}`
  );
  const webCommand = isolatedCommand(
    'web',
    `NEXT_PUBLIC_API_URL='' PORT=3002 ${runScriptCommand(webPackageManager, 'dev')} -- --host 0.0.0.0 --port 3002`
  );
  const proxyCommand = `node <<'NODE'
const http = require('http');

const routes = {
  api: { hostname: '127.0.0.1', port: 3001 },
  web: { hostname: '127.0.0.1', port: 3002 }
};

function isAssetPath(pathname = '/') {
  return (
    pathname.startsWith('/@') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/sockjs-node') ||
    pathname === '/favicon.ico' ||
    /\\.[A-Za-z0-9]+$/.test(pathname)
  );
}

function prefersHtml(headers = {}) {
  const accept = String(headers.accept || headers.Accept || '').toLowerCase();
  return accept.includes('text/html');
}

function targetFor(req) {
  const rawUrl = req.url || '/';
  let pathname = '/';
  try {
    pathname = new URL(rawUrl, 'http://preview.local').pathname || '/';
  } catch {
    pathname = rawUrl;
  }
  if (pathname === '/' || pathname === '/index.html') return routes.web;
  if (pathname === '/health' || pathname.startsWith('/api')) return routes.api;
  if (String(req.headers.upgrade || '').toLowerCase() === 'websocket') return routes.web;
  if (isAssetPath(pathname)) return routes.web;
  return prefersHtml(req.headers) ? routes.web : routes.api;
}

const server = http.createServer((req, res) => {
  const target = targetFor(req);
  const headers = { ...req.headers, host: target.hostname + ':' + target.port };
  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(\`preview upstream unavailable: \${err.message}\`);
  });

  req.pipe(proxyReq);
});

server.listen(3000, '0.0.0.0', () => {
  console.log('[preview-proxy] listening on 3000');
});
NODE`;
  const previewCommand = [
    'set -eu',
    "trap 'kill 0' EXIT INT TERM",
    `${serverCommand} &`,
    `${webCommand} &`,
    proxyCommand
  ].join('\n');

  return {
    previewCommand,
    previewPort: 3000,
    hmrCapable: false,
    scriptName: 'fullstack',
    relDir: '.',
    packageManager: rootPackageManager,
    unsupported: false
  };
}

async function analyzePackageDir({ dirPath, relDir }, rootPkg, config) {
  const pkg = await readJson(path.join(dirPath, 'package.json'));
  if (!pkg) return null;
  const scripts = pkg.scripts || {};
  const lockfilePath = await findNearestLockfile(dirPath);
  const packageManager = packageManagerForLockfile(lockfilePath, true);
  const dependencySet = dependencyNames(pkg);
  const rootHasWorkspaces = Array.isArray(rootPkg?.workspaces) || Boolean(rootPkg?.workspaces);
  const runDev = scripts.dev ? runScriptCommand(packageManager, 'dev') : '';
  const runStart = scripts.start ? runScriptCommand(packageManager, 'start') : '';
  const commands = [];
  if (runDev) {
    commands.push({
      scriptName: 'dev',
      scriptCommand: String(scripts.dev || ''),
      command: runDev
    });
  }
  if (runStart) {
    commands.push({
      scriptName: 'start',
      scriptCommand: String(scripts.start || ''),
      command: runStart
    });
  }
  const installCommand = installCommandForManager(packageManager);
  const nodeModulesExists = await fileExists(path.join(dirPath, 'node_modules'));
  const depth = relDir === '.' ? 0 : relDir.split('/').length;
  return {
    dirPath,
    relDir,
    depth,
    pkg,
    scripts,
    dependencySet,
    lockfilePath,
    packageManager,
    installCommand,
    hasInstallableDependencies: hasInstallableDependencies(pkg),
    nodeModulesExists,
    rootHasWorkspaces,
    config,
    commands,
    packageName: typeof pkg.name === 'string' ? pkg.name : ''
  };
}

function buildInstallPlan(candidates, rootPkg) {
  const rootCandidate = candidates.find((candidate) => candidate.relDir === '.');
  const rootHasWorkspaces = Array.isArray(rootPkg?.workspaces) || Boolean(rootPkg?.workspaces);
  if (rootHasWorkspaces && rootCandidate?.installCommand) {
    return {
      installCommand: rootCandidate.installCommand,
      lockfileHash: rootCandidate.lockfileHash,
      packageManager: rootCandidate.packageManager,
      installTargets: ['.'],
      needsInstall: !rootCandidate.nodeModulesExists
    };
  }

  const installTargets = candidates
    .filter(
      (candidate) =>
        candidate.installCommand &&
        (candidate.hasInstallableDependencies || (candidate.rootHasWorkspaces && candidate.relDir === '.'))
    )
    .sort((a, b) => a.depth - b.depth || a.relDir.localeCompare(b.relDir));
  const parts = installTargets.map((candidate) => isolatedCommand(candidate.relDir, candidate.installCommand));
  const needsInstall = installTargets.some((candidate) => !candidate.nodeModulesExists);
  const lockfileHash = installTargets.map((candidate) => candidate.lockfileHash).filter(Boolean).join(':');
  const packageManager = installTargets[0]?.packageManager || null;
  return {
    installCommand: parts.join(' && ') || null,
    lockfileHash,
    packageManager,
    installTargets: installTargets.map((candidate) => candidate.relDir),
    needsInstall
  };
}

async function selectPreviewCandidate(candidates, rootPkg, config) {
  if (config?.previewCommand) {
    return {
      previewCommand: String(config.previewCommand),
      previewPort: Number(config.previewPort || 3000) || 3000,
      hmrCapable: /\b(dev|vite|next dev|astro dev)\b/i.test(String(config.previewCommand)),
      scriptName: 'custom',
      relDir: '.',
      packageManager: null,
      unsupported: false
    };
  }

  const staticFullstackPreview = await detectStaticFullstackPreview(rootPkg);
  if (staticFullstackPreview) return staticFullstackPreview;

  const rootHasWorkspaces = Array.isArray(rootPkg?.workspaces) || Boolean(rootPkg?.workspaces);
  const rootCandidate = candidates.find((candidate) => candidate.relDir === '.');
  const rootPackageManager = rootCandidate?.packageManager || 'npm';
  const previewOptions = [];
  for (const candidate of candidates) {
    for (const command of candidate.commands) {
      const workspaceCommand = rootHasWorkspaces && candidate.relDir !== '.'
        ? workspaceAwareRunCommand(rootPackageManager, candidate.packageName, command.scriptName)
        : '';
      previewOptions.push({
        relDir: candidate.relDir,
        depth: candidate.depth,
        pkg: candidate.pkg,
        dependencySet: candidate.dependencySet,
        packageManager: candidate.packageManager,
        scriptName: command.scriptName,
        scriptCommand: command.scriptCommand,
        hmrCapable: command.scriptName === 'dev' || /\b(vite|next dev|astro dev|react-scripts start)\b/i.test(command.scriptCommand),
        command: workspaceCommand || prefixedCommand(candidate.relDir, command.command)
      });
    }
  }

  if (previewOptions.length === 0) {
    return {
      previewCommand: null,
      previewPort: Number(config?.previewPort || 3000) || 3000,
      hmrCapable: false,
      scriptName: '',
      relDir: '.',
      packageManager: null,
      unsupported: true
    };
  }

  previewOptions.sort((a, b) => scoreCandidate(b, rootHasWorkspaces) - scoreCandidate(a, rootHasWorkspaces));
  const winner = previewOptions[0];
  return {
    previewCommand: winner.command,
    previewPort: inferPort(winner, Number(config?.previewPort || 0) || 0),
    hmrCapable: winner.hmrCapable,
    scriptName: winner.scriptName,
    relDir: winner.relDir,
    packageManager: winner.packageManager,
    unsupported: false
  };
}

async function main() {
  const config = await readJson(path.join(repoPath, 'vibes.config.json'));
  const rootPkg = await readJson(path.join(repoPath, 'package.json'));
  const packageDirs = await walkPackageDirs(repoPath);
  const candidates = (await Promise.all(packageDirs.map((entry) => analyzePackageDir(entry, rootPkg, config))))
    .filter(Boolean);

  for (const candidate of candidates) {
    candidate.lockfileHash = candidate.lockfilePath ? await hashFile(candidate.lockfilePath) : '';
  }

  const installPlan = buildInstallPlan(candidates, rootPkg);
  const previewPlan = await selectPreviewCandidate(candidates, rootPkg, config);
  const result = {
    installCommand: installPlan.installCommand || null,
    previewCommand: previewPlan.previewCommand || null,
    previewPort: previewPlan.previewPort,
    lockfileHash: installPlan.lockfileHash || '',
    packageManager: previewPlan.packageManager || installPlan.packageManager || null,
    hmrCapable: Boolean(previewPlan.hmrCapable),
    unsupported: Boolean(previewPlan.unsupported || !previewPlan.previewCommand),
    installTargets: installPlan.installTargets,
    needsInstall: Boolean(installPlan.needsInstall),
    previewPath: previewPlan.relDir || '.',
    previewScript: previewPlan.scriptName || ''
  };
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
