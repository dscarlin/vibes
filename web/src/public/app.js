const API_URL = window.__API_URL__ || 'http://localhost:8000';
const DOMAIN = window.__DOMAIN__ || 'localhost:8000';
const UPGRADE_URL = window.__UPGRADE_URL__ || '';
const DESKTOP_BRIDGE = Boolean(window.__TAURI__?.core);

const state = {
  token: localStorage.getItem('vibes_token') || '',
  user: null,
  projects: [],
  projectId: null,
  projectsLoaded: false,
  projectsLoading: false,
  projectsError: '',
  environment: 'development',
  nerdLevel: localStorage.getItem('vibes_nerd_level') || 'beginner',
  tasks: [],
  sessions: [],
  buildStatus: {
    development: 'offline',
    testing: 'offline',
    production: 'offline'
  },
  deployedCommit: {
    development: '',
    testing: '',
    production: ''
  },
  pendingDeployCommit: {
    development: '',
    testing: '',
    production: ''
  },
  progressVisibleUntil: {
    development: 0,
    testing: 0,
    production: 0
  },
  updatedAt: {
    development: '',
    testing: '',
    production: ''
  },
  latestBuild: {
    development: null,
    testing: null,
    production: null
  },
  lastSuccessBuild: {
    development: null,
    testing: null,
    production: null
  },
  failedBuildLog: {
    development: null,
    testing: null,
    production: null
  },
  failedBuildLogVisible: {
    development: false,
    testing: false,
    production: false
  },
  failedBuildLogLoading: {
    development: false,
    testing: false,
    production: false
  },
  failedBuildLogError: {
    development: '',
    testing: '',
    production: ''
  },
  failedBuildLogLines: {
    development: 200,
    testing: 200,
    production: 200
  },
  uploadBusy: false,
  downloadBusy: false,
  repoMessage: '',
  envVarsMap: {
    development: '',
    testing: '',
    production: ''
  },
  envEditing: {
    development: false,
    testing: false,
    production: false
  },
  envBusy: false,
  envMessage: '',
  darkMode: localStorage.getItem('vibes_dark_mode') === 'true',
  settingsOpen: false,
  healthSettings: {
    healthcheck_path: '/',
    healthcheck_path_dev: '',
    healthcheck_path_test: '',
    healthcheck_path_prod: '',
    healthcheck_protocol: '',
    healthcheck_protocol_dev: '',
    healthcheck_protocol_test: '',
    healthcheck_protocol_prod: '',
    healthcheck_timeout_ms: '60000',
    healthcheck_interval_ms: '3000'
  },
  demoMode: false,
  demoOpenAiKey: '',
  settingsBusy: false,
  settingsMessage: '',
  confirmOpen: false,
  confirmMessage: '',
  confirmConfirmText: 'Confirm',
  confirmCancelText: 'Cancel',
  promptOpen: false,
  promptMessage: '',
  promptPlaceholder: '',
  promptValue: '',
  promptConfirmText: 'Save',
  promptCancelText: 'Cancel',
  deletingProject: false,
  deployWebhookUrl: '',
  deployWebhookBusy: false,
  deployWebhookMessage: '',
  createProjectStack: 'expo',
  createInterfaces: {
    web: true,
    mobile: false
  },
  createProjectName: '',
  desktopSettings: {
    useLocalApi: false,
    localApiUrl: '',
    startCommand: '',
    iosCommand: '',
    androidCommand: '',
    androidEmulatorWindowConfigured: false,
    projectPaths: {}
  },
  localRunLog: '',
  localRunLogPath: '',
  localRunLogHeader: '',
  localRunBusy: false,
  localRunWaiting: false,
  localRunWaitMessage: '',
  localRunNotice: '',
  localRunActive: false,
  localRunPlatform: '',
  localRunDevices: {
    ios: [],
    android: []
  },
  androidSetupStatus: null,
  androidSetupBusy: false,
  androidSetupLog: '',
  androidSetupOpen: false,
  androidSetupStep: 1,
  androidSetupMessage: '',
  iosSetupStatus: null,
  iosSetupBusy: false,
  iosSetupOpen: false,
  iosSetupStep: 1,
  iosSetupMessage: '',
  taskLogs: {},
  taskDetails: {},
  sessionDetails: {},
  taskPromptDraft: '',
  activeTaskId: null,
  taskStatusMessage: '',
  taskStatusPersistent: false,
  runtimeUsage: { month: '', plan: '', usage: {} },
  runtimeUsageLoading: false,
  runtimeUsageError: '',
  runtimeQuotaNotice: {}
};

let socketClient = null;
let socketProjectId = null;
let runtimeUsageTimer = null;
let taskStatusTimer = null;
let headerProgressTimer = null;
let confirmResolver = null;
let promptResolver = null;
let localRunTailTimer = null;
let localRunWaitTimer = null;

function scheduleHeaderProgressRefresh(delay = 3100) {
  if (headerProgressTimer) {
    clearTimeout(headerProgressTimer);
  }
  headerProgressTimer = setTimeout(() => {
    setState({ progressVisibleUntil: { ...state.progressVisibleUntil } });
  }, delay);
}

function envStorageKey(userId, projectId) {
  if (!userId || !projectId) return null;
  return `vibes_env_${userId}_${projectId}`;
}

function projectStorageKey(userId) {
  if (!userId) return null;
  return `vibes_project_${userId}`;
}

function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!json?.userId) return null;
    return { id: json.userId, email: json.email || '' };
  } catch {
    return null;
  }
}

function desktopSettingsKey(userId) {
  if (!userId) return null;
  return `vibes_desktop_settings_${userId}`;
}

function loadDesktopSettings(userId) {
  const defaults = {
    useLocalApi: false,
    localApiUrl: 'http://localhost:4000',
    startCommand: 'npm run dev',
    iosCommand: 'npx expo run:ios',
    androidCommand: 'npx expo run:android',
    androidEmulatorWindowConfigured: false,
    projectPaths: {},
    projectSync: {}
  };
  const key = desktopSettingsKey(userId);
  if (!key) return defaults;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveDesktopSettings(userId, settings) {
  const key = desktopSettingsKey(userId);
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(settings));
}

function normalizeUrl(url) {
  if (!url) return '';
  let next = url.trim();
  if (!/^https?:\/\//i.test(next)) {
    next = `http://${next}`;
  }
  return next.replace(/\/+$/, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function apiBaseUrl() {
  if (DESKTOP_BRIDGE && state.desktopSettings?.useLocalApi && state.desktopSettings?.localApiUrl) {
    return normalizeUrl(state.desktopSettings.localApiUrl);
  }
  return normalizeUrl(API_URL);
}

function isAndroidSetupComplete(status) {
  if (!status) return false;
  const hasTools = Boolean(status.sdk_root && status.sdkmanager && status.avdmanager && status.emulator && status.adb);
  const hasAvd = Array.isArray(status.avds) && status.avds.length > 0;
  return Boolean(status.studio_installed && hasTools && hasAvd && state.desktopSettings?.androidEmulatorWindowConfigured);
}

function hasAndroidDevice(status) {
  return Array.isArray(status?.devices) && status.devices.length > 0;
}

function nextAndroidSetupStep(status) {
  if (!status?.studio_installed) return 1;
  const hasTools = Boolean(status.sdk_root && status.sdkmanager && status.emulator && status.adb);
  if (!hasTools) return 2;
  const hasAvd = Array.isArray(status.avds) && status.avds.length > 0;
  if (!hasAvd) return 3;
  if (!state.desktopSettings?.androidEmulatorWindowConfigured) return 4;
  return 5;
}

function isIosSetupComplete(status) {
  if (!status || status.supported === false) return false;
  const hasSim = Array.isArray(status.simulators) && status.simulators.length > 0;
  return Boolean(status.xcode_installed && status.xcode_license && hasSim);
}

function nextIosSetupStep(status) {
  if (!status || status.supported === false) return 1;
  if (!status.xcode_installed) return 1;
  if (!status.xcode_license) return 2;
  const hasSim = Array.isArray(status.simulators) && status.simulators.length > 0;
  if (!hasSim) return 3;
  return 4;
}

async function getLocalLanIp() {
  if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return '';
  try {
    const ip = await window.__TAURI__.core.invoke('get_local_lan_ip');
    return typeof ip === 'string' ? ip : '';
  } catch {
    return '';
  }
}

async function canReachUrl(url, timeoutMs = 800) {
  if (!DESKTOP_BRIDGE) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function extractLogPath(output = '') {
  const match = output.match(/Logs:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

function stopLocalRunTail() {
  if (localRunTailTimer) {
    clearInterval(localRunTailTimer);
    localRunTailTimer = null;
  }
}

async function refreshLocalRunTail() {
  if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return;
  if (!state.localRunLogPath) return;
  try {
    const tail = await window.__TAURI__.core.invoke('read_log_tail', {
      path: state.localRunLogPath,
      maxBytes: 14000
    });
    const header = state.localRunLogHeader || '';
    const next = header ? `${header}\n${tail || ''}` : `${tail || ''}`;
    if (next.trim() !== (state.localRunLog || '').trim()) {
      updateLocalRunLog(next);
    }
  } catch (err) {
    updateLocalRunLog(`\n${err?.message || err}`, { append: true });
  }
}

function startLocalRunTail(path, header = '') {
  stopLocalRunTail();
  setState({ localRunLogPath: path, localRunLogHeader: header });
  refreshLocalRunTail();
  localRunTailTimer = setInterval(refreshLocalRunTail, 1500);
}

function stopLocalRunWait() {
  if (localRunWaitTimer) {
    clearTimeout(localRunWaitTimer);
    localRunWaitTimer = null;
  }
}

async function stopLocalRunProcess() {
  if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return;
  stopLocalRunTail();
  stopLocalRunWait();
  setState({ localRunWaiting: false, localRunWaitMessage: '', localRunActive: false, localRunNotice: '' });
  try {
    const output = await window.__TAURI__.core.invoke('stop_local_runs');
    if (output) {
      updateLocalRunLog(`\n${output}`, { append: true });
    }
  } catch (err) {
    setState({ localRunNotice: err?.message || String(err) });
  }
}

async function waitForRuntime(platform, timeoutMs = 120000) {
  if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return false;
  stopLocalRunWait();
  const started = Date.now();
  setState({
    localRunWaiting: true,
    localRunPlatform: platform,
    localRunWaitMessage: platform === 'ios'
      ? 'Waiting for iOS Simulator and Metro…'
      : 'Waiting for Android Emulator and Metro…'
  });
  while (Date.now() - started < timeoutMs) {
    try {
      const metroOk = await window.__TAURI__.core.invoke('is_port_open', {
        host: '127.0.0.1',
        port: 8081,
        timeoutMs: 400
      });
      if (platform === 'ios') {
        const status = await window.__TAURI__.core.invoke('ios_runtime_status');
        const nextDevices = status?.devices || [];
        if (JSON.stringify(nextDevices) !== JSON.stringify(state.localRunDevices.ios || [])) {
          setState({
            localRunDevices: { ...state.localRunDevices, ios: nextDevices }
          });
        }
        if (status?.booted && metroOk) {
          setState({ localRunWaiting: false, localRunWaitMessage: '' });
          return true;
        }
      } else {
        const status = await window.__TAURI__.core.invoke('android_runtime_status');
        const nextDevices = status?.devices || [];
        if (JSON.stringify(nextDevices) !== JSON.stringify(state.localRunDevices.android || [])) {
          setState({
            localRunDevices: { ...state.localRunDevices, android: nextDevices }
          });
        }
        if (status?.booted && metroOk) {
          setState({ localRunWaiting: false, localRunWaitMessage: '' });
          return true;
        }
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => {
      localRunWaitTimer = setTimeout(resolve, 1500);
    });
  }
  setState({
    localRunWaiting: true,
    localRunWaitMessage: 'Still waiting for the emulator/simulator to finish launching.'
  });
  return false;
}

async function mobileApiUrlForProject(platform = 'ios') {
  const project = state.projects.find((p) => p.id === state.projectId);
  if (!project) return '';
  const env = state.environment || 'development';
  const raw = `${projectProtocol()}://${projectUrl(project, env)}`;
  const normalized = normalizeUrl(raw);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return normalized;
  }
  const host = parsed.hostname;
  const isLocalDomain = DOMAIN.includes('localhost') || DOMAIN.includes('127.0.0.1');
  if (isLocalDomain) {
    const subdomain = (host === 'localhost' || host === '127.0.0.1') ? '' : host.split('.')[0];
    if (platform === 'android') {
      // Android emulator DNS may not resolve nip.io subdomains. Use plain 10.0.2.2.
      parsed.hostname = '10.0.2.2';
      return normalizeUrl(parsed.toString());
    }
    parsed.hostname = subdomain ? `${subdomain}.lvh.me` : 'lvh.me';
    return normalizeUrl(parsed.toString());
  }
  return normalized;
}

function projectRepoPath(projectId) {
  if (!projectId) return '';
  return state.desktopSettings?.projectPaths?.[projectId] || '';
}

function parseIsoTime(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestRemoteActivity(tasks = [], sessions = []) {
  let latest = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const ts = parseIsoTime(task.completed_at || task.created_at);
    if (ts > latest) latest = ts;
  }
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const ts = parseIsoTime(session.updated_at || session.created_at);
    if (ts > latest) latest = ts;
  }
  return latest;
}

async function refreshProjectActivity(projectId) {
  let tasks = null;
  let sessions = null;
  try {
    tasks = await api(`/projects/${projectId}/tasks`);
    setState({ tasks });
  } catch {
    tasks = state.tasks;
  }
  try {
    sessions = await api(`/projects/${projectId}/sessions`);
    setState({ sessions });
  } catch {
    sessions = state.sessions;
  }
  return latestRemoteActivity(tasks, sessions);
}

async function ensureDesktopRepo(projectId) {
  if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return '';
  if (!state.token || !projectId) return '';
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return '';
  const existingPath = projectRepoPath(projectId);
  let localOk = false;
  if (existingPath) {
    try {
      const check = await window.__TAURI__.core.invoke('run_local_command', {
        command: 'find . -maxdepth 3 -name package.json -print -quit',
        cwd: existingPath
      });
      if (String(check || '').trim()) localOk = true;
    } catch {
      localOk = false;
    }
  }
  if (localOk) {
    const remoteLatest = await refreshProjectActivity(projectId);
    const syncInfo = state.desktopSettings?.projectSync?.[projectId] || {};
    const syncedAt = parseIsoTime(syncInfo.remoteUpdatedAt);
    if (!remoteLatest || remoteLatest <= syncedAt) {
      setState({ localRunLog: `${state.localRunLog}Using existing local repo.\n` });
      return existingPath;
    }
  }
  setState({ localRunBusy: true, localRunLog: `Syncing local repo for ${project.name}...\n` });
  try {
    const remoteLatest = await refreshProjectActivity(projectId);
    const localPath = await window.__TAURI__.core.invoke('ensure_project_repo', {
      apiBaseUrl: normalizeUrl(API_URL),
      token: state.token,
      projectId,
      projectName: project.name,
      force: true
    });
    const syncedAt = new Date().toISOString();
    const remoteUpdatedAt = remoteLatest ? new Date(remoteLatest).toISOString() : syncedAt;
    const nextDesktopSettings = {
      ...state.desktopSettings,
      projectPaths: { ...state.desktopSettings.projectPaths, [projectId]: localPath }
    };
    nextDesktopSettings.projectSync = {
      ...(state.desktopSettings?.projectSync || {}),
      [projectId]: { syncedAt, remoteUpdatedAt }
    };
    saveDesktopSettings(state.user?.id, nextDesktopSettings);
    setState({
      desktopSettings: nextDesktopSettings,
      localRunLog: `${state.localRunLog}Repo ready at ${localPath}\n`
    });
    return localPath;
  } catch (err) {
    setTaskStatus(`Repo sync failed: ${err?.message || err}`, { autoHide: true });
    return '';
  } finally {
    setState({ localRunBusy: false });
  }
}

async function forceSyncDesktopRepo(projectId) {
  if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return true;
  if (!state.token || !projectId) return true;
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return true;
  const existingPath = projectRepoPath(projectId);
  if (existingPath) {
    let dirty = false;
    try {
      const status = await window.__TAURI__.core.invoke('run_local_command', {
        command: 'git status --porcelain',
        cwd: existingPath
      });
      const trimmed = String(status || '').trim();
      if (trimmed.length > 0 || /fatal|not a git repository/i.test(trimmed)) dirty = true;
    } catch {
      dirty = true;
    }
    if (dirty) {
      const ok = await showConfirm('Local repo has changes and will be overwritten. Continue?', {
        confirmText: 'Overwrite',
        cancelText: 'Cancel'
      });
      if (!ok) return false;
    }
  }
  setState({ localRunBusy: true, localRunLog: `Refreshing local repo for ${project.name}...\n` });
  try {
    const localPath = await window.__TAURI__.core.invoke('ensure_project_repo', {
      apiBaseUrl: normalizeUrl(API_URL),
      token: state.token,
      projectId,
      projectName: project.name,
      force: true
    });
    const nextDesktopSettings = {
      ...state.desktopSettings,
      projectPaths: { ...state.desktopSettings.projectPaths, [projectId]: localPath }
    };
    saveDesktopSettings(state.user?.id, nextDesktopSettings);
    setState({
      desktopSettings: nextDesktopSettings,
      localRunLog: `${state.localRunLog}Repo refreshed at ${localPath}\n`
    });
    return true;
  } catch (err) {
    setTaskStatus(`Repo refresh failed: ${err?.message || err}`, { autoHide: true });
    return false;
  } finally {
    setState({ localRunBusy: false });
  }
}

function loadStoredEnv(userId, projectId) {
  const key = envStorageKey(userId, projectId);
  if (!key) return null;
  const val = localStorage.getItem(key);
  if (['development', 'testing', 'production'].includes(val)) return val;
  return null;
}

function storeEnv(userId, projectId, env) {
  const key = envStorageKey(userId, projectId);
  if (!key) return;
  localStorage.setItem(key, env);
}

function loadStoredProject(userId, projects) {
  const key = projectStorageKey(userId);
  if (!key) return null;
  const val = localStorage.getItem(key);
  if (!val) return null;
  return projects.some((p) => p.id === val) ? val : null;
}

function storeProject(userId, projectId) {
  const key = projectStorageKey(userId);
  if (!key || !projectId) return;
  localStorage.setItem(key, projectId);
}

function setState(partial) {
  Object.assign(state, partial);
  document.querySelector('app-shell')?.render();
}

function updateLocalRunLog(text, { append = false } = {}) {
  const next = append ? `${state.localRunLog || ''}${text}` : (text || '');
  state.localRunLog = next;
  const el = document.querySelector('.local-run-log');
  if (el) {
    el.textContent = next || 'No local runs yet.';
    el.scrollTop = el.scrollHeight;
    return;
  }
  setState({ localRunLog: next });
}

function setTaskStatus(message, { autoHide = false, persistent = false } = {}) {
  if (taskStatusTimer) {
    clearTimeout(taskStatusTimer);
    taskStatusTimer = null;
  }
  setState({ taskStatusMessage: message, taskStatusPersistent: persistent });
  if (autoHide) {
    taskStatusTimer = setTimeout(() => {
      setState({ taskStatusMessage: '', taskStatusPersistent: false });
    }, 2500);
  }
}

function showError(err, { autoHide = true, persistent = false } = {}) {
  const message = err?.message || String(err || '');
  const isPlanError = Boolean(err?.code && String(err.code).startsWith('plan_'));
  setTaskStatus(message, { autoHide: !isPlanError && autoHide, persistent: isPlanError || persistent });
}

function showConfirm(message, { confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    setState({
      confirmOpen: true,
      confirmMessage: message,
      confirmConfirmText: confirmText,
      confirmCancelText: cancelText
    });
  });
}

function showPrompt(message, {
  placeholder = '',
  confirmText = 'Save',
  cancelText = 'Cancel',
  initialValue = ''
} = {}) {
  return new Promise((resolve) => {
    promptResolver = resolve;
    setState({
      promptOpen: true,
      promptMessage: message,
      promptPlaceholder: placeholder,
      promptValue: initialValue,
      promptConfirmText: confirmText,
      promptCancelText: cancelText
    });
  });
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function resolveUpgradeUrl() {
  if (UPGRADE_URL) return UPGRADE_URL;
  const domain = String(DOMAIN || '').toLowerCase();
  const isLocal = domain.includes('localhost')
    || domain.includes('lvh.me')
    || domain.includes('nip.io')
    || domain.startsWith('127.')
    || domain.startsWith('10.')
    || domain.startsWith('192.168.')
    || domain.startsWith('172.');
  if (isLocal) return 'https://vibesplatform.ai/pricing';
  const protocol = window.location?.protocol && window.location.protocol.startsWith('http')
    ? window.location.protocol
    : 'https:';
  return `${protocol}//${DOMAIN}/pricing`;
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => chunk[0]?.toUpperCase() + chunk.slice(1))
    .join(' ');
}

function formatHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  if (Math.abs(num - Math.round(num)) < 0.05) return String(Math.round(num));
  return num.toFixed(1).replace(/\.0$/, '');
}

function formatRuntimeQuotaNotice(details = {}) {
  const envLabel = titleCase(details.environment || '');
  const planName = titleCase(details.plan || '');
  const used = formatHours(details.used_hours ?? 0);
  const limit = formatHours(details.limit_hours ?? 0);
  const upgradeHref = resolveUpgradeUrl();
  const upgradeCta = upgradeHref
    ? ` <a class="plan-cta" href="${upgradeHref}" target="_blank" rel="noreferrer">Upgrade plan</a>`
    : '';
  return `
    <strong>Runtime quota reached${envLabel ? ` for ${envLabel}` : ''}.</strong>
    <span class="plan-subtext">${used}h of ${limit}h used this month.</span>
    <span class="plan-subtext">Environment paused to prevent overages.${planName ? ` Current plan: ${planName}.` : ''}</span>
    ${upgradeCta}
  `.trim();
}

function formatPlanError(code, details = {}) {
  const planName = titleCase(details.plan || '');
  const env = details.environment ? titleCase(details.environment) : '';
  const upgradeHref = resolveUpgradeUrl();
  const upgradeCta = upgradeHref
    ? ` <a class="plan-cta" href="${upgradeHref}" target="_blank" rel="noreferrer">Upgrade plan</a>`
    : '';
  if (code === 'plan_project_limit') {
    const limit = details.limit ?? '';
    return `You’ve reached your plan’s project limit.${planName ? ` <span class="plan-subtext">Current plan: ${planName}. Limit: ${limit}.</span>` : ''} <span class="plan-subtext">Upgrade to add more projects.</span>${upgradeCta}`;
  }
  if (code === 'plan_env_not_allowed') {
    return `Your plan doesn’t include the <strong>${env || 'requested'}</strong> environment.${planName ? ` <span class="plan-subtext">Current plan: ${planName}.</span>` : ''} <span class="plan-subtext">Upgrade to unlock ${env || 'that'} environment.</span>${upgradeCta}`;
  }
  if (code === 'plan_mobile_not_allowed') {
    return `Mobile builds aren’t included in your current plan.${planName ? ` <span class="plan-subtext">Current plan: ${planName}.</span>` : ''} <span class="plan-subtext">Upgrade to Builder or higher for mobile builds.</span>${upgradeCta}`;
  }
  if (code === 'plan_runtime_quota_exceeded') {
    const limit = details.limit_hours ?? '';
    const used = details.used_hours ?? '';
    const envLabel = env || 'requested';
    const usage =
      limit || used
        ? ` <span class="plan-subtext">${used || '0'}h used of ${limit || '?'}h this month.</span>`
        : '';
    return `You’ve hit your ${envLabel} runtime quota.${planName ? ` <span class="plan-subtext">Current plan: ${planName}.</span>` : ''}${usage} <span class="plan-subtext">Upgrade to increase runtime limits.</span>${upgradeCta}`;
  }
  if (code === 'plan_build_limit') {
    const limit = details.limit ?? '';
    const count = details.count ?? '';
    const usage =
      limit || count
        ? ` <span class="plan-subtext">${count || '0'} builds used of ${limit || '?'} this month.</span>`
        : '';
    return `You’ve reached your monthly build limit.${planName ? ` <span class="plan-subtext">Current plan: ${planName}.</span>` : ''}${usage} <span class="plan-subtext">Upgrade to build more this month.</span>${upgradeCta}`;
  }
  if (code === 'plan_db_storage_limit') {
    const limit = details.limit_gb ?? '';
    const used = details.used_gb ?? '';
    const envLabel = env || 'requested';
    const usage =
      limit || used
        ? ` <span class="plan-subtext">${used || '0'} GB used of ${limit || '?'} GB.</span>`
        : '';
    return `Database size limit reached for ${envLabel}.${planName ? ` <span class="plan-subtext">Current plan: ${planName}.</span>` : ''}${usage} <span class="plan-subtext">Upgrade to increase database limits.</span>${upgradeCta}`;
  }
  if (code === 'plan_bandwidth_limit') {
    const limit = details.limit_gb ?? '';
    const used = details.used_gb ?? '';
    const usage =
      limit || used
        ? ` <span class="plan-subtext">${used || '0'} GB used of ${limit || '?'} GB this month.</span>`
        : '';
    return `Bandwidth limit reached for this project.${planName ? ` <span class="plan-subtext">Current plan: ${planName}.</span>` : ''}${usage} <span class="plan-subtext">Upgrade to increase bandwidth limits.</span>${upgradeCta}`;
  }
  return null;
}

async function api(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(fetchOptions.headers || {})
    },
    ...(controller ? { signal: controller.signal } : {})
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.error || 'request_failed';
    const err = new Error(code);
    err.code = code;
    err.details = data || {};
    if (String(code).startsWith('plan_')) {
      const message = formatPlanError(code, data);
      if (message) err.message = message;
    }
    throw err;
  }
  return res.json();
}

async function loadProjects() {
  if (!state.token) return;
  setState({ projectsLoading: true, projectsError: '' });
  try {
    const projects = await api('/projects', { timeoutMs: 20000 });
    const storedProjectId = loadStoredProject(state.user?.id, projects);
    const hasCurrent = projects.some((p) => p.id === state.projectId);
    const projectId = hasCurrent
      ? state.projectId
      : (storedProjectId || projects[0]?.id || null);
    const storedEnv = loadStoredEnv(state.user?.id, projectId);
    if (projectId) storeProject(state.user?.id, projectId);
    setState({ projects, projectId, environment: storedEnv || state.environment });
    await loadRuntimeUsage();
    if (!projectId) {
      setState({
        tasks: [],
        sessions: [],
        envVars: {},
        buildStatus: { development: 'offline', testing: 'offline', production: 'offline' },
        deployedCommit: { development: '', testing: '', production: '' },
        pendingDeployCommit: { development: '', testing: '', production: '' },
        progressVisibleUntil: { development: 0, testing: 0, production: 0 },
        updatedAt: { development: '', testing: '', production: '' },
        lastSuccessBuild: { development: null, testing: null, production: null },
        failedBuildLog: { development: null, testing: null, production: null },
        failedBuildLogVisible: { development: false, testing: false, production: false },
        failedBuildLogLoading: { development: false, testing: false, production: false },
        failedBuildLogError: { development: '', testing: '', production: '' },
        failedBuildLogLines: { development: 200, testing: 200, production: 200 },
        environment: 'development',
        nerdLevel: 'beginner'
      });
      return;
    }
    await loadTasks(projectId);
    await loadSessions(projectId);
    await loadEnvVars(projectId, state.environment);
    await loadLatestBuild(projectId, state.environment);
    await loadLastSuccessBuilds(projectId);
    await loadDeployWebhook(projectId);
    connectSocket(projectId);
    const project = projects.find((p) => p.id === projectId);
    if (project?.environments) {
      setState({
        buildStatus: {
          development: project.environments.development?.build_status || 'offline',
          testing: project.environments.testing?.build_status || 'offline',
          production: project.environments.production?.build_status || 'offline'
        },
        deployedCommit: {
          development: project.environments.development?.deployed_commit || '',
          testing: project.environments.testing?.deployed_commit || '',
          production: project.environments.production?.deployed_commit || ''
        },
        updatedAt: {
          development: project.environments.development?.updated_at || '',
          testing: project.environments.testing?.updated_at || '',
          production: project.environments.production?.updated_at || ''
        }
      });
    }
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? 'Projects request timed out. Check your connection or API URL.'
      : (err?.message || 'Failed to load projects.');
    setState({ projectsError: message });
  } finally {
    setState({ projectsLoading: false, projectsLoaded: true });
    startRuntimeUsagePolling();
  }
}

async function loadRuntimeUsage() {
  if (!state.token) return;
  setState({ runtimeUsageLoading: true, runtimeUsageError: '' });
  try {
    const data = await api('/usage/runtime', { timeoutMs: 15000 });
    setState({ runtimeUsage: data, runtimeUsageLoading: false });
  } catch (err) {
    setState({ runtimeUsageLoading: false, runtimeUsageError: err.message || 'Failed to load runtime usage.' });
  }
}

function startRuntimeUsagePolling() {
  if (runtimeUsageTimer) return;
  if (!state.token) return;
  runtimeUsageTimer = setInterval(loadRuntimeUsage, 60000);
}

function stopRuntimeUsagePolling() {
  if (!runtimeUsageTimer) return;
  clearInterval(runtimeUsageTimer);
  runtimeUsageTimer = null;
}

async function loadTasks(projectId) {
  const tasks = await api(`/projects/${projectId}/tasks`);
  setState({ tasks });
}

async function loadSessions(projectId) {
  const sessions = await api(`/projects/${projectId}/sessions`);
  setState({ sessions });
}

async function loadLatestBuild(projectId, environment) {
  const build = await api(`/projects/${projectId}/builds/latest?environment=${environment}`);
  state.latestBuild[environment] = build;
  if (build?.status) {
    state.buildStatus[environment] = build.status;
  }
  setState({
    latestBuild: { ...state.latestBuild },
    buildStatus: { ...state.buildStatus }
  });
}

async function loadFailedBuildLog(projectId, environment, { force = false, lines } = {}) {
  if (!projectId) return;
  if (!force && state.failedBuildLogVisible[environment] && state.failedBuildLog[environment]) return;
  const nextLines = Math.max(1, Math.min(Number(lines || state.failedBuildLogLines[environment] || 200), 2000));
  state.failedBuildLogLines[environment] = nextLines;
  state.failedBuildLogLoading[environment] = true;
  state.failedBuildLogError[environment] = '';
  setState({
    failedBuildLogLoading: { ...state.failedBuildLogLoading },
    failedBuildLogError: { ...state.failedBuildLogError },
    failedBuildLogLines: { ...state.failedBuildLogLines }
  });
  try {
    const data = await api(
      `/projects/${projectId}/builds/log?environment=${environment}&status=failed&lines=${nextLines}`
    );
    state.failedBuildLog[environment] = data;
    state.failedBuildLogVisible[environment] = true;
    setState({
      failedBuildLog: { ...state.failedBuildLog },
      failedBuildLogVisible: { ...state.failedBuildLogVisible }
    });
  } catch (err) {
    state.failedBuildLogError[environment] = err?.message || 'Failed to load build log.';
    setState({
      failedBuildLogError: { ...state.failedBuildLogError }
    });
  } finally {
    state.failedBuildLogLoading[environment] = false;
    setState({
      failedBuildLogLoading: { ...state.failedBuildLogLoading }
    });
  }
}

async function loadLastSuccessBuilds(projectId) {
  try {
    const data = await api(`/projects/${projectId}/builds/summary`);
    const envs = data?.environments || {};
    setState({
      lastSuccessBuild: {
        ...state.lastSuccessBuild,
        ...envs
      }
    });
  } catch {
    // keep existing state; no UI error for this optional data
  }
}

async function fetchRuntimeLogs(id, lines) {
  if (!id) return;
  const current = state.taskLogs[id] || {};
  const nextLines = Math.max(1, Math.min(Number(lines || current.lines || 200), 2000));
  state.taskLogs[id] = { ...current, loading: true, error: '', lines: nextLines };
  setState({ taskLogs: { ...state.taskLogs } });
  try {
    const env = state.environment;
    const data = await api(`/projects/${state.projectId}/runtime-logs?environment=${env}&lines=${nextLines}`);
    state.taskLogs[id] = { ...state.taskLogs[id], loading: false, serverLog: data.logs || '', lines: nextLines };
    setState({ taskLogs: { ...state.taskLogs } });
  } catch (err) {
    state.taskLogs[id] = { ...state.taskLogs[id], loading: false, error: err.message, lines: nextLines };
    setState({ taskLogs: { ...state.taskLogs } });
  }
}

async function openRuntimeLogs(id) {
  if (!id) return;
  const current = state.taskLogs[id] || { open: false };
  if (!current.open) {
    state.taskLogs[id] = { ...current, open: true };
    setState({ taskLogs: { ...state.taskLogs } });
  }
  await fetchRuntimeLogs(id);
}

async function loadDeployWebhook(projectId) {
  if (!projectId) return;
  try {
    const data = await api(`/projects/${projectId}/webhook`);
    setState({ deployWebhookUrl: data?.url || '', deployWebhookMessage: '' });
  } catch {
    setState({ deployWebhookUrl: '', deployWebhookMessage: '' });
  }
}

async function loadHealthSettings() {
  const data = await api('/settings/healthcheck');
  const defaults = {
    healthcheck_path: '/',
    healthcheck_path_dev: '',
    healthcheck_path_test: '',
    healthcheck_path_prod: '',
    healthcheck_protocol: '',
    healthcheck_protocol_dev: '',
    healthcheck_protocol_test: '',
    healthcheck_protocol_prod: '',
    healthcheck_timeout_ms: '60000',
    healthcheck_interval_ms: '3000'
  };
  setState({ healthSettings: { ...defaults, ...data } });
}

async function loadDemoSettings() {
  const data = await api('/settings/demo-openai-key');
  setState({
    demoMode: Boolean(data?.enabled),
    demoOpenAiKey: data?.openaiApiKey || ''
  });
}

async function loadEnvVars(projectId, environment) {
  const data = await api(`/projects/${projectId}/env/${environment}`);
  const lines = Object.entries(data.envVars || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  state.envVarsMap[environment] = lines;
  setState({ envVarsMap: { ...state.envVarsMap } });
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatRelative(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function parseHealthcheckFailure(build) {
  if (!build || build.status !== 'failed') return null;
  const log = build.build_log || '';
  if (!/health check failed/i.test(log)) return null;
  const marker = 'Pod logs';
  const idx = log.indexOf(marker);
  if (idx === -1) {
    return { message: log.trim() || 'Health check failed.', podLogs: '', raw: log };
  }
  const message = log.slice(0, idx).trim() || 'Health check failed.';
  const podLogs = log
    .slice(idx)
    .replace(/^Pod logs[^\n]*\n?/, '')
    .trim();
  return { message, podLogs, raw: log };
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function hostProjectName(name) {
  const cleaned = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'app';
}

function isProjectNameTaken(name, excludeId = null) {
  const needle = (name || '').trim().toLowerCase();
  if (!needle) return false;
  return state.projects.some((project) => {
    if (excludeId && project.id === excludeId) return false;
    return (project.name || '').trim().toLowerCase() === needle;
  });
}

function projectUrl(project, env) {
  if (!project) return '';
  const slug = project.project_slug || hostProjectName(project.name);
  const suffix = project.short_id ? `-${project.short_id}` : '';
  const base = env === 'production'
    ? `${slug}${suffix}`
    : `${slug}-${env}${suffix}`;
  return `${base}.${DOMAIN}`;
}

function projectProtocol() {
  const domain = DOMAIN || '';
  if (domain.includes('localhost') || domain.includes('127.0.0.1') || domain.includes(':')) {
    return 'http';
  }
  return 'https';
}

async function openExternalLink(url) {
  if (!url) return;
  if (DESKTOP_BRIDGE && window.__TAURI__?.core?.invoke) {
    try {
      if (window.__TAURI__?.shell?.open) {
        await window.__TAURI__.shell.open(url);
        return;
      }
      await window.__TAURI__.core.invoke('open_external', { url });
      return;
    } catch {
      // fall through to browser open
    }
  }
  window.open(url, '_blank', 'noopener');
}

function settingsShortcutLabel() {
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  if (/Mac/i.test(platform) || /Mac OS/i.test(ua)) return 'Cmd + ,';
  return 'Ctrl + Alt + S';
}

function badgeClass(status) {
  if (!status) return 'badge';
  if (status === 'live') return 'badge live';
  if (status === 'building' || status === 'running' || status === 'queued') return 'badge building';
  if (status === 'failed') return 'badge failed';
  return 'badge';
}

function connectSocket(projectId) {
  if (!window.io) return;
  socketProjectId = projectId;
  if (!socketClient) {
    socketClient = window.io(apiBaseUrl(), { transports: ['websocket'] });
    socketClient.on('connect', () => {
      if (socketProjectId) socketClient.emit('joinProject', socketProjectId);
    });
    socketClient.on('projectStatus', (payload) => {
      if (!payload?.environments || payload.projectId !== state.projectId) return;
      const envs = payload.environments;
      const nextBuildStatus = {
        development: envs.development?.build_status || 'offline',
        testing: envs.testing?.build_status || 'offline',
        production: envs.production?.build_status || 'offline'
      };
      const nextRuntimeNotice = { ...(state.runtimeQuotaNotice || {}) };
      const projectNotices = { ...(nextRuntimeNotice[state.projectId] || {}) };
      (['development', 'testing', 'production']).forEach((env) => {
        if (projectNotices[env] && nextBuildStatus[env] !== 'offline') {
          delete projectNotices[env];
        }
      });
      if (Object.keys(projectNotices).length) {
        nextRuntimeNotice[state.projectId] = projectNotices;
      } else if (nextRuntimeNotice[state.projectId]) {
        delete nextRuntimeNotice[state.projectId];
      }
      const nextProgress = { ...state.progressVisibleUntil };
      (['development', 'testing', 'production']).forEach((env) => {
        const prev = state.buildStatus[env] || 'offline';
        const next = nextBuildStatus[env];
        if (next === 'building') {
          nextProgress[env] = 0;
        }
        if (prev === 'building' && (next === 'live' || next === 'failed')) {
          nextProgress[env] = Date.now() + 3000;
          scheduleHeaderProgressRefresh();
        }
      });
      const nextDeployed = {
        development: envs.development?.deployed_commit || '',
        testing: envs.testing?.deployed_commit || '',
        production: envs.production?.deployed_commit || ''
      };
      const nextUpdated = {
        development: envs.development?.updated_at || '',
        testing: envs.testing?.updated_at || '',
        production: envs.production?.updated_at || ''
      };
      const nextProjects = state.projects.map((project) => {
        if (project.id !== payload.projectId) return project;
        return { ...project, environments: envs };
      });
      setState({
        buildStatus: nextBuildStatus,
        deployedCommit: nextDeployed,
        updatedAt: nextUpdated,
        projects: nextProjects,
        progressVisibleUntil: nextProgress,
        runtimeQuotaNotice: nextRuntimeNotice
      });
    });
    socketClient.on('projectUpdated', (payload) => {
      const project = state.projects.find((p) => p.id === state.projectId);
      if (project && payload.snapshotStatus) {
        project.snapshot_status = payload.snapshotStatus;
        setState({ projects: [...state.projects] });
      }
    });
    socketClient.on('projectDeleted', (payload) => {
      if (!payload?.projectId) return;
      const remaining = state.projects.filter((p) => p.id !== payload.projectId);
      const nextProjectId = remaining[0]?.id || null;
      if (nextProjectId) {
        storeProject(state.user?.id, nextProjectId);
      } else {
        const key = projectStorageKey(state.user?.id);
        if (key) localStorage.removeItem(key);
      }
      const nextRuntimeNotice = { ...(state.runtimeQuotaNotice || {}) };
      if (nextRuntimeNotice[payload.projectId]) delete nextRuntimeNotice[payload.projectId];
      setState({ projects: remaining, projectId: nextProjectId, runtimeQuotaNotice: nextRuntimeNotice });
      if (!nextProjectId) {
        setState({
          tasks: [],
          sessions: [],
          envVars: {},
          buildStatus: { development: 'offline', testing: 'offline', production: 'offline' },
          deployedCommit: { development: '', testing: '', production: '' },
          pendingDeployCommit: { development: '', testing: '', production: '' },
          progressVisibleUntil: { development: 0, testing: 0, production: 0 },
          updatedAt: { development: '', testing: '', production: '' },
          lastSuccessBuild: { development: null, testing: null, production: null },
          failedBuildLog: { development: null, testing: null, production: null },
          failedBuildLogVisible: { development: false, testing: false, production: false },
          failedBuildLogLoading: { development: false, testing: false, production: false },
          failedBuildLogError: { development: '', testing: '', production: '' },
          failedBuildLogLines: { development: 200, testing: 200, production: 200 }
        });
      } else {
        loadTasks(nextProjectId);
        loadSessions(nextProjectId);
        loadEnvVars(nextProjectId, state.environment);
        loadLatestBuild(nextProjectId, state.environment);
        loadLastSuccessBuilds(nextProjectId);
        connectSocket(nextProjectId);
      }
    });
    socketClient.on('taskUpdated', (payload) => {
      const idx = state.tasks.findIndex((t) => t.id === payload.id);
      if (idx >= 0) {
        state.tasks[idx] = { ...state.tasks[idx], ...payload };
        setState({ tasks: [...state.tasks] });
      }
      if (payload.id && payload.id === state.activeTaskId) {
        if (payload.status === 'running') {
          setTaskStatus('Designing and implementing changes', { persistent: true });
        }
        if (payload.status === 'completed') {
          setTaskStatus('Deploying your update', { persistent: true });
        }
      }
    });
    socketClient.on('taskDeleted', (payload) => {
      const nextTasks = state.tasks.filter((t) => t.id !== payload.id);
      if (nextTasks.length !== state.tasks.length) {
        delete state.taskLogs[payload.id];
        delete state.taskDetails[payload.id];
        setState({
          tasks: nextTasks,
          taskLogs: { ...state.taskLogs },
          taskDetails: { ...state.taskDetails }
        });
      }
    });
    socketClient.on('buildUpdated', (payload) => {
      const env = payload.environment;
      const prevStatus = state.buildStatus[env] || 'offline';
      state.buildStatus[env] = payload.status;
      if (payload.refCommit) {
        state.deployedCommit[env] = payload.refCommit;
      }
      if (payload.updatedAt) {
        state.updatedAt[env] = payload.updatedAt;
      }
      if (payload.status === 'live' || payload.status === 'failed') {
        state.pendingDeployCommit[env] = '';
      }
      if (payload.status === 'offline') {
        state.pendingDeployCommit[env] = '';
      }
      if (payload.status === 'building') {
        state.progressVisibleUntil[env] = 0;
        if (payload.refCommit) {
          state.pendingDeployCommit[env] = payload.refCommit;
        }
        if (env === state.environment) {
          let targetId = state.activeTaskId;
          if (!targetId && payload.refCommit) {
            targetId = state.tasks.find((t) => t.commit_hash === payload.refCommit)?.id || null;
          }
          if (!targetId) {
            targetId = state.tasks[0]?.id || null;
          }
          if (targetId && !state.taskLogs[targetId]?.open) {
            openRuntimeLogs(targetId);
          }
        }
      }
      if (prevStatus === 'building' && (payload.status === 'live' || payload.status === 'failed')) {
        state.progressVisibleUntil[env] = Date.now() + 3000;
        scheduleHeaderProgressRefresh();
      }
      if (env === state.environment && state.taskStatusPersistent) {
        if (payload.status === 'building') {
          setTaskStatus('Deploying your update', { persistent: true });
        }
        if (payload.status === 'live') {
          setTaskStatus('Your application is ready to view at the link to the left', { autoHide: true });
          setState({ activeTaskId: null });
        }
      }
      if (env === state.environment && (payload.status === 'failed' || payload.status === 'live')) {
        loadLatestBuild(state.projectId, env);
      }
      if (payload.status === 'live') {
        loadLastSuccessBuilds(state.projectId);
      }
      const nextRuntimeNotice = { ...(state.runtimeQuotaNotice || {}) };
      const projectNotices = { ...(nextRuntimeNotice[state.projectId] || {}) };
      if (projectNotices[env] && payload.status !== 'offline') {
        delete projectNotices[env];
      }
      if (Object.keys(projectNotices).length) {
        nextRuntimeNotice[state.projectId] = projectNotices;
      } else if (nextRuntimeNotice[state.projectId]) {
        delete nextRuntimeNotice[state.projectId];
      }
      setState({
        buildStatus: { ...state.buildStatus },
        deployedCommit: { ...state.deployedCommit },
        updatedAt: { ...state.updatedAt },
        pendingDeployCommit: { ...state.pendingDeployCommit },
        progressVisibleUntil: { ...state.progressVisibleUntil },
        runtimeQuotaNotice: nextRuntimeNotice
      });
    });
    socketClient.on('runtimeQuotaExceeded', (payload) => {
      const env = payload?.environment;
      if (!env || !state.projectId) return;
      const message = formatRuntimeQuotaNotice(payload);
      const nextRuntimeNotice = { ...(state.runtimeQuotaNotice || {}) };
      const projectNotices = { ...(nextRuntimeNotice[state.projectId] || {}) };
      projectNotices[env] = message;
      nextRuntimeNotice[state.projectId] = projectNotices;
      setState({ runtimeQuotaNotice: nextRuntimeNotice });
      if (env === state.environment) {
        setTaskStatus(message, { persistent: true });
      }
    });
  }
  if (socketClient.connected && socketProjectId) {
    socketClient.emit('joinProject', socketProjectId);
  }
}

class AppShell extends HTMLElement {
  connectedCallback() {
    this.render();
    if (state.token) {
      connectSocket(state.projectId);
      if (!this._ticker) {
        this._ticker = setInterval(() => this.refreshRelativeTimes(), 30000);
      }
    }
  }

  disconnectedCallback() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }

  refreshRelativeTimes() {
    this.querySelectorAll('[data-rel-time]').forEach((el) => {
      const ts = el.getAttribute('data-rel-time');
      el.textContent = formatRelative(ts);
    });
  }

  render() {
    const project = state.projects.find((p) => p.id === state.projectId) || null;
    const isAuthed = Boolean(state.token);
    document.body.classList.toggle('app-dark', isAuthed && state.darkMode);
    this.innerHTML = `
      ${this.renderIconSprite()}
      ${isAuthed ? `
        <header class="app-header">
          <div class="header-grid">
           <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <span class="brand-cube">
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
              </span>
            </span>
            Vibes Platform
          </div>
          <div class="project-env">
              ${this.renderProjectSelect(project)}
              ${this.renderEnvBadges()}
              ${this.renderEnvStop()}
              ${this.renderNerdLevel()}
            </div>
            <div class="header-actions">
              ${this.renderPlanBadge()}
              ${this.renderAccountMenu()}
            </div>
          </div>

        ${this.renderHeaderProgress()}
        </header>
        <main>
          ${this.renderMain(project)}
        </main>
        ${this.renderModal()}
        ${this.renderConfirmModal()}
        ${this.renderPromptModal()}
        ${this.renderAndroidSetupModal()}
        ${this.renderIosSetupModal()}
        ${this.renderDeletingModal()}
        ${this.renderSettings()}
      ` : `
        ${this.renderAuth()}
      `}
    `;
    this.bind();
  }

  renderIconSprite() {
    return `
      <svg class="icon-sprite" aria-hidden="true" focusable="false">
        <symbol id="icon-account" viewBox="0 0 24 24">
          <path d="M20 21a8 8 0 0 0-16 0"></path>
          <circle cx="12" cy="8" r="4"></circle>
        </symbol>
        <symbol id="icon-launch" viewBox="0 0 24 24">
          <path d="M14 3h7v7"></path>
          <path d="M21 3L10 14"></path>
          <path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"></path>
        </symbol>
        <symbol id="icon-trash" viewBox="0 0 24 24">
          <path d="M4 7h16"></path>
          <path d="M9 7V4h6v3"></path>
          <path d="M7 7l1 13h8l1-13"></path>
        </symbol>
        <symbol id="icon-logs" viewBox="0 0 24 24">
          <path d="M4 7h16"></path>
          <path d="M4 12h16"></path>
          <path d="M4 17h10"></path>
        </symbol>
        <symbol id="icon-copy" viewBox="0 0 24 24">
          <rect x="9" y="9" width="10" height="10" rx="2"></rect>
          <rect x="5" y="5" width="10" height="10" rx="2"></rect>
        </symbol>
      </svg>
    `;
  }

  renderProjectSelect(project) {
    if (!state.projectsLoaded) {
      return `
        <div class="control-stack">
          <label class="control-label">Projects</label>
          <select id="projectSelect" disabled>
            <option selected>Loading projects…</option>
          </select>
        </div>
      `;
    }
    const stackLabelMap = {
      web: 'Web',
      expo: 'Expo',
      rn_cli: 'RN CLI'
    };
    const interfaceLabels = [];
    const webEnabled = project?.interface_web !== false;
    const mobileEnabled = Boolean(project?.interface_mobile);
    if (webEnabled) interfaceLabels.push('Web');
    if (mobileEnabled) {
      interfaceLabels.push(stackLabelMap[project?.mobile_stack_type] || 'Mobile');
    }
    const stackLabel = interfaceLabels.length ? interfaceLabels.join(' + ') : 'Web';
    const options = state.projects.map((p) => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${p.name}</option>`).join('');
    return `
      <div class="control-stack project-select">
        <label class="control-label">Projects</label>
        <select id="projectSelect" class="control-select">
          <option value="__new__" ${!state.projectId ? 'selected' : ''}>Create New Project</option>
          ${options}
        </select>
        ${project ? `<span class="tag stack-tag">${stackLabel}</span>` : ''}
      </div>
    `;
  }

  renderEnvSelect() {
    const envs = ['development', 'testing', 'production'];
    return `
      <div class="row">
        ${envs.map((env) => `
          <label>
            <input type="radio" name="env" value="${env}" ${state.environment === env ? 'checked' : ''} />
            ${env[0].toUpperCase()}${env.slice(1)}
          </label>
        `).join('')}
      </div>
    `;
  }

  renderNerdLevel() {
    if (!state.projectId) return '';
    const isDisabled = !state.projectId;
    return `
      <div class="control-stack nerd-level">
        <label class="control-label right">Nerd Level</label>
        <select id="nerdLevel" class="control-select" ${isDisabled ? 'disabled' : ''}>
          <option value="beginner" ${state.nerdLevel === 'beginner' ? 'selected' : ''}>Beginner</option>
          <option value="intermediate" ${state.nerdLevel === 'intermediate' ? 'selected' : ''}>Intermediate</option>
          <option value="advanced" ${state.nerdLevel === 'advanced' ? 'selected' : ''}>Advanced</option>
        </select>
        ${this.renderRuntimeBadge()}
      </div>
    `;
  }

  renderEnvBadges() {
    const envs = ['development', 'testing', 'production'];
    const statusText = (status) => {
      if (status === 'live') return 'Live';
      if (status === 'building') return 'Building';
      if (status === 'failed') return 'Failed';
      return 'Offline';
    };
    return state.nerdLevel === 'beginner' ? '' : `
      <div class="env-badges">
        ${envs.map((env,idx) => {
          const status = state.buildStatus[env] || 'offline';
          const isActive = state.environment === env;
          const isLocked = state.nerdLevel === 'beginner';
          const success = state.lastSuccessBuild?.[env];
          const successAt = success?.updated_at || success?.created_at || '';
          const duration = formatDurationMs(success?.duration_ms);
          const durationText = duration && duration !== 'n/a' ? ` · ${duration}` : '';
          const metaText = successAt
            ? `Last success ${formatRelative(successAt)}${durationText}`
            : 'No successful deploy yet';
          return `
            <button class="env-pill ${isActive ? 'active' : ''} ${idx === 0 ? 'env-left' : idx === 1 ? 'env-middle' : 'env-right'}" type="button" data-env="${env}" ${isLocked ? 'disabled' : ''} aria-pressed="${isActive}">
              <span class="tag">${env}</span>
              <span class="status-text ${status}">${statusText(status)}</span>
              <span class="env-meta">${metaText}</span>
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  renderEnvStop() {
    if (!state.projectId) return '';
    const status = state.buildStatus[state.environment] || 'offline';
    if (status !== 'building' && status !== 'live') return '';
    return `
      <div class="env-stop">
        <button class="env-stop-button" id="stopEnvironment" type="button">Stop</button>
      </div>
    `;
  }

  renderAccountMenu() {
    return `
      <details class="account-menu">
        <summary class="icon-button account-button" aria-label="Account menu">
          ${icon('account')}
        </summary>
        <div class="menu">
          <button class="menu-item" type="button" id="openSettings">Settings</button>
          <button class="menu-item" type="button" id="logout">Logout</button>
        </div>
      </details>
    `;
  }

  renderAuth() {
    return `
      <div class="page landing">
        <header class="top-bar" aria-label="Primary">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <span class="brand-cube">
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
              </span>
            </span>
            Vibes Platform
          </div>
          <nav class="top-nav" aria-label="Top navigation">
            <a href="#how" class="nav-link">How it works</a>
            <a href="#features" class="nav-link">Features</a>
            <a href="#audiences" class="nav-link">Why Vibes</a>
          </nav>
          <div class="auth-actions">
            <button class="ghost" type="button" data-auth-target="login">Log in</button>
            <button class="primary" type="button" data-auth-target="register">Register</button>
          </div>
        </header>

        <main>
          <section class="hero" aria-labelledby="hero-title">
            <div class="hero-content">
              <p class="eyebrow">The future of website development is here</p>
              <h1 id="hero-title">Zero Code Required</h1>
              <h1 id="hero-title">Scalable and Secure</h1>
              <h1 id="hero-title">AI Powered</h1>
              <p class="subhead">
                Vibes Platform handles architecture, code, version control, and scalable hosting. Export code
                any time. Iterate in minutes with full stakeholder control.
              </p>
              <div class="hero-actions">
                <button class="primary" type="button" data-auth-target="register">Register</button>
                <a class="ghost" href="#how">See how it works</a>
              </div>
              <div class="hero-metrics" role="list">
                <div class="metric" role="listitem">
                  <span class="metric-value">6x</span>
                  <span class="metric-label">Faster delivery</span>
                </div>
                <div class="metric" role="listitem">
                  <span class="metric-value">0</span>
                  <span class="metric-label">Experience overhead</span>
                </div>
                <div class="metric" role="listitem">
                  <span class="metric-value">100%</span>
                  <span class="metric-label">Code ownership</span>
                </div>
              </div>
            </div>
            <div class="hero-visual" aria-hidden="true">
              <div class="holo-panel">
                <div class="scene">
                  <div class="cube cube-main">
                    <div class="face"></div>
                    <div class="face"></div>
                    <div class="face"></div>
                    <div class="face"></div>
                    <div class="face"></div>
                    <div class="face"></div>
                  </div>
                </div>
                <div class="holo-caption">Idea to reality in seconds</div>
                <div class="holo-caption">AI automated</div>
                <div class="holo-caption">Simple</div>
              
              </div>
            </div>
          </section>

          <section id="how" class="section">
            <div class="section-header">
              <h2>How it works</h2>
              <p>Six steps from request to production, all inside a single AI-driven workspace.</p>
            </div>
            <div class="steps">
              <div class="step-card">
                <span class="step-num">01</span>
                <h3>Describe</h3>
                <p>Explain what you need in plain language or technical requirements.</p>
              </div>
              <div class="step-card">
                <span class="step-num">02</span>
                <h3>AI Builds</h3>
                <p>Your website and data storage are detailed to meet your requirements.</p>
              </div>
              <div class="step-card">
                <span class="step-num">03</span>
                <h3>Review</h3>
                <p>Try out your app instantly from a preview url.</p>
              </div>
              <div class="step-card">
                <span class="step-num">04</span>
                <h3>Iterate</h3>
                <p>Approve or adjust new versions in minutes.</p>
              </div>
              <div class="step-card">
                <span class="step-num">05</span>
                <h3>Testing</h3>
                <p>Use a testing url to validate changes while continuing to develop.</p>
              </div>
              <div class="step-card">
                <span class="step-num">06</span>
                <h3>Production</h3>
                <p>Go live with updates to your site with no downtime. Roll back to previous state any time.</p>
               
              </div>
            </div>
          </section>

          <section id="features" class="section glass">
            <div class="section-header">
              <h2>Feature highlights</h2>
              <p>Everything required to build, own, and go live with modern software.</p>
            </div>
            <div class="feature-grid">
              <article class="feature-card">
                <h3>AI-driven architecture</h3>
                <p>Designs systems, APIs, and data models that scale without rework.</p>
              </article>
              <article class="feature-card">
                <h3>Built-in version control</h3>
                <p>Full Git history, reviews, and exports included with every build.</p>
              </article>
              <article class="feature-card">
                <h3>Scalable hosting</h3>
                <p>Globally available with automated scaling and resilience baked in.</p>
              </article>
              <article class="feature-card">
                <h3>Codebase Management</h3>
                <p>Upload your existing codebase and get up and running in minutes.</p>
                <p>Download your codebase at any time.</p>

              </article>
              <article class="feature-card">
                <h3>Instant iteration cycles</h3>
                <p>Request, approval, and updates move from days to minutes.</p>
              </article>
              <article class="feature-card">
                <h3>AI-augmented control</h3>
                <p>Stay in charge with clear diffs, approvals, and customizable workflows.</p>
              </article>
            </div>
          </section>

          <section id="audiences" class="section">
            <div class="section-header">
              <h2>Built for every stakeholder</h2>
              <p>One platform, three wins: build fast, go live faster, stay in control.</p>
            </div>
            <div class="audience-grid">
              <article class="audience-card">
                <h3>For builders</h3>
                <p>Launch without technical knowledge. The AI handles setup, hosting, and polish.</p>
                <ul class="audience-list">
                  <li>Guided prompts for non-technical founders</li>
                  <li>Instant previews and content updates</li>
                  <li>Implement requirements as you define them</li>
                </ul>
              </article>
              <article class="audience-card">
                <h3>For developers</h3>
                <p>Ship production code faster with full control and real infrastructure.</p>
                <ul class="audience-list">
                  <li>Readable, exportable codebase</li>
                  <li>Automated testing and CI workflows</li>
                  <li>Scalable deployments out of the box</li>
                </ul>
              </article>
              <article class="audience-card">
                <h3>For business leaders</h3>
                <p>Move from request to approval in minutes without hiring large teams.</p>
                <ul class="audience-list">
                  <li>Stakeholder approvals built into the flow</li>
                  <li>Secure deployments with no ops knowledge required</li>
                  <li>Full ownership and compliance-ready exports</li>
                </ul>
              </article>
            </div>
          </section>

          <section class="section final-cta">
            <div class="cta-panel">
              <div>
                <h2>Ready to build without the bottlenecks?</h2>
                <p>
                  Launch your next product with AI-managed architecture, instant iteration cycles, and zero
                  lock-in.
                </p>
              </div>
              <div class="download-panel">
                <div class="download-header">
                  <span class="tag">Desktop App</span>
                  <p class="notice">Run projects locally with mobile simulators and device support.</p>
                </div>
                <div class="download-grid">
                  <a class="ghost download-card" href="${API_URL}/downloads/desktop?platform=mac" target="_blank" rel="noreferrer">
                    <strong>macOS</strong>
                    <span>Download .dmg</span>
                  </a>
                  <a class="ghost download-card" href="${API_URL}/downloads/desktop?platform=windows" target="_blank" rel="noreferrer">
                    <strong>Windows</strong>
                    <span>Download .exe</span>
                  </a>
                  <a class="ghost download-card" href="${API_URL}/downloads/desktop?platform=linux" target="_blank" rel="noreferrer">
                    <strong>Linux</strong>
                    <span>Download .AppImage</span>
                  </a>
                </div>
                <p class="notice">Downloads are hosted directly from the platform server.</p>
              </div>
            </div>
          </section>
        </main>

        <div class="auth-modal" aria-hidden="true">
          <div class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button class="auth-close" type="button" aria-label="Close">Close</button>
            <div class="auth-panel" data-auth-panel="register">
              <h2 id="auth-title">Register your workspace</h2>
              <p>Start with a single prompt. Scale when it clicks.</p>
              <div class="grid">
                <input id="registerEmail" type="email" placeholder="Email" />
                <input id="registerPassword" type="password" placeholder="Password (optional)" />
                <button id="registerBtn">Register</button>
              </div>
            </div>
            <div class="auth-panel" data-auth-panel="login">
              <h2>Welcome back</h2>
              <p>Pick up where your team left off.</p>
              <div class="grid">
                <input id="loginEmail" type="email" placeholder="Email" />
                <input id="loginPassword" type="password" placeholder="Password (optional)" />
                <button id="loginBtn">Log in</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderMain(project) {
    if (!state.projectsLoaded) {
      return `
        <div class="content">
          <div class="card">
            <h2>Loading projects…</h2>
            <p class="notice">Hang tight while we sync your workspace.</p>
          </div>
        </div>
      `;
    }
    if (state.projectsError) {
      return `
        <div class="content">
          <div class="card">
            <h2>Unable to load projects</h2>
            <p class="notice">${state.projectsError}</p>
            <div class="row">
              <button id="retryProjects">Retry</button>
            </div>
          </div>
        </div>
      `;
    }
    if (!project) {
      return `
        <div class="content">
          ${this.renderCreateProject()}
        </div>
      `;
    }
    const quotaNotice = state.runtimeQuotaNotice?.[project.id]?.[state.environment] || '';
    const isDev = state.environment === 'development';
    const showSubmit = isDev;
    const showTasks = isDev && state.nerdLevel !== 'beginner';
    const showAdvanced = state.nerdLevel === 'advanced';
    const showSavedSessions = state.nerdLevel !== 'beginner';
   
    return `
      <div class="content">
        ${quotaNotice ? `<div class="notice quota-notice">${quotaNotice}</div>` : ''}
        <div class="grid">
          ${showAdvanced ? this.renderAdvanced(project) : ''}
          ${showSubmit ? this.renderSubmit(project) : ''}
          ${showTasks ? this.renderTasks(project) : ''}
          ${showSavedSessions ? this.renderSavedSessions(project, isDev) : ''}
        </div>
      </div>
    `;
  }

  renderHeaderProgress() {
    const env = state.environment;
    const status = state.buildStatus[env] || 'offline';
    const visibleUntil = state.progressVisibleUntil?.[env] || 0;
    const shouldShow = status === 'building' || Date.now() < visibleUntil;
    if (!shouldShow) return '';
    return `
      <div class="header-progress">
        <div class="bar ${status}"></div>
      </div>
    `;
  }

  renderCreateProject() {
    const mobileSelected = state.createInterfaces.mobile;
    return `
      <div class="card">
        <h2>Launch the Future of Your SMB Website</h2>
        <p class="notice">Describe your business in plain English. We design, build, and deploy a site that grows with you.</p>
        ${state.taskStatusMessage ? `<div class="notice plan-error">${state.taskStatusMessage}</div>` : ''}
        <div class="stepper">
          <div class="step">
            <div class="step-num">1</div>
            <div>
              <strong>Brand it once</strong>
              <p class="notice">A project becomes your live, scalable web presence.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div>
              <strong>Describe your vision</strong>
              <p class="notice">We generate design, content, and the full customer journey.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div>
              <strong>Launch with confidence</strong>
              <p class="notice">Preview, iterate, and go live in minutes.</p>
            </div>
          </div>
        </div>
        <div class="grid">
          <input id="createProjectName" type="text" placeholder="Project name" value="${escapeHtml(state.createProjectName)}" maxlength="30" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
          <div class="interface-choice">
            <label class="checkbox">
              <input id="createInterfaceWeb" type="checkbox" ${state.createInterfaces.web ? 'checked' : ''} />
              <span>Web App</span>
            </label>
            <label class="checkbox">
              <input id="createInterfaceMobile" type="checkbox" ${state.createInterfaces.mobile ? 'checked' : ''} />
              <span>Mobile App</span>
            </label>
          </div>
          ${mobileSelected ? `
            <div class="interface-stack">
              <label class="tag">Mobile Stack</label>
              <div class="stack-options">
                <label class="radio">
                  <input type="radio" name="mobileStack" value="expo" ${state.createProjectStack === 'expo' ? 'checked' : ''} />
                  <span>Quick Setup with Expo (Recommended)</span>
                </label>
                <label class="radio">
                  <input type="radio" name="mobileStack" value="rn_cli" ${state.createProjectStack === 'rn_cli' ? 'checked' : ''} />
                  <span>Detailed Setup and Control with React Native CLI (Advanced)</span>
                </label>
              </div>
            </div>
          ` : ''}
          <button id="createProjectBtn">Create Project</button>
        </div>
      </div>
    `;
  }

  renderPlanBadge() {
    const plan = state.user?.plan;
    if (!plan) return '';
    return `<div class="plan-badge">Plan: ${titleCase(plan)}</div>`;
  }

  renderRuntimeBadge() {
    if (state.runtimeUsageLoading) {
      return `<div class="runtime-badge runtime-loading">Runtime: …</div>`;
    }
    const usage = state.runtimeUsage?.usage?.[state.environment];
    if (!usage) return '';
    if (!usage.limit_hours) return '';
    const used = formatHours(usage.used_hours || 0);
    const limit = formatHours(usage.limit_hours);
    const percent = Math.min(100, Math.max(0, Number(usage.percent || 0)));
    const envLabel = titleCase(state.environment);
    return `
      <div class="runtime-badge" title="${envLabel} runtime this month">
        <div class="runtime-bar" style="width:${percent}%"></div>
        <span>${envLabel} runtime: ${used}h / ${limit}h</span>
      </div>
    `;
  }

  renderSubmit(project) {
    const latest = state.latestBuild[state.environment];
    const showBuildLog = latest && latest.status === 'failed';
    const failedLog = state.failedBuildLog[state.environment];
    const failedLogVisible = state.failedBuildLogVisible[state.environment];
    const failedLogLoading = state.failedBuildLogLoading[state.environment];
    const failedLogError = state.failedBuildLogError[state.environment];
    const failedLogTruncated = Boolean(failedLog?.truncated);
    const hasFailedLog = Boolean(failedLog?.build_log || failedLogError);
    const isBeginner = state.nerdLevel === 'beginner';
    return `
      <div class="card">
        <div class="section-title">
          <h2>Submit Task</h2>
          <span class="badge ${badgeClass(state.buildStatus[state.environment])}">${state.buildStatus[state.environment]}</span>
        </div>
        ${state.taskStatusMessage  ? `
          <div class="task-status">
            <div class="status-cube" aria-hidden="true">
              <div class="cube">
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
                <span class="face"></span>
              </div>
            </div>
            <div class="status-text">${state.taskStatusMessage}</div>
          </div>
        ` : ''}
        <p class="notice"><a class="tag view-project-link" href="${projectProtocol()}://${projectUrl(project, state.environment)}" target="_blank" rel="noreferrer">View your project</a></p>
        <textarea id="taskPrompt" placeholder="A good title for the feature or fix you want to make...\n\nDescribe exactly what you want to see, what you expect \nto happen when you click somewhere etc...\n\nWatch your ideas come to life!\nIn moments you will be viewing the updates${isBeginner ? '.' : '\nand reading a summary of what we have done!'}">${state.taskPromptDraft || ''}</textarea>
        <div class="row m-top-sm">
          <button id="submitTask">Submit</button>
        </div>
        ${!showBuildLog && hasFailedLog ? `
          <div class="notice m-top-sm">
            Last deploy failed. <button class="link-button" type="button" id="openFailedBuildLog">View log</button>
          </div>
        ` : ''}
        ${!showBuildLog ? `
          <div class="row m-top-sm">
            <button class="ghost" id="toggleFailedBuildLog" ${failedLogLoading ? 'disabled' : ''}>
              ${failedLogVisible ? 'Hide last failed build log' : 'View last failed build log'}
            </button>
            ${failedLogError ? `<span class="notice">${failedLogError}</span>` : ''}
          </div>
        ` : ''}
        ${showBuildLog ? `
          <details class="build-log" open>
            <summary>Latest Build Log</summary>
            <pre>${latest.build_log || 'No build log available.'}</pre>
            <button class="ghost" id="refreshBuildLog">Refresh Log</button>
          </details>
        ` : ''}
        ${!showBuildLog && failedLogVisible ? `
          <details class="build-log" open>
            <summary>Last Failed Build Log</summary>
            <pre>${failedLogLoading ? 'Loading...' : (failedLog?.build_log || 'No failed build log available.')}</pre>
            <div class="row m-top-sm">
              <button class="ghost" id="refreshFailedBuildLog" ${failedLogLoading ? 'disabled' : ''}>Refresh Log</button>
              ${failedLogTruncated ? `<button class="ghost" id="expandFailedBuildLog" ${failedLogLoading ? 'disabled' : ''}>View full log (2000 lines)</button>` : ''}
            </div>
          </details>
        ` : ''}
      </div>
    `;
  }

  renderDatabaseCard() {
    return '';
  }

  renderAdvanced(project) {
    const envText = state.envVarsMap[state.environment] || '';
    const envCount = envText.split('\n').map((line) => line.trim()).filter(Boolean).length;
    const envSummary = envCount === 0 ? 'No variables saved yet.' : `${envCount} variable${envCount === 1 ? '' : 's'} saved.`;
    const isEditingEnv = state.envEditing?.[state.environment];
    const androidReady = isAndroidSetupComplete(state.androidSetupStatus);
    const iosReady = isIosSetupComplete(state.iosSetupStatus);
    const activeDeviceList = state.localRunPlatform === 'ios'
      ? state.localRunDevices.ios
      : state.localRunPlatform === 'android'
        ? state.localRunDevices.android
        : [];
    const iosActive = state.localRunActive && state.localRunPlatform === 'ios';
    const androidActive = state.localRunActive && state.localRunPlatform === 'android';
    return `
      <div class="card grid two">
        <div>
          <h3>Repo Upload / Download</h3>
          <input id="repoFile" class="file-input" type="file" accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-gtar,application/x-tar" />
          <div class="row">
            <button id="uploadRepo" class="file-button" ${state.uploadBusy ? 'disabled' : ''}>${state.uploadBusy ? 'Uploading...' : 'Upload Repo'}</button>
            <button class="ghost" id="downloadRepo" ${state.downloadBusy ? 'disabled' : ''}>${state.downloadBusy ? 'Downloading...' : 'Download'}</button>
          </div>
          <p class="notice">${state.repoMessage || 'Validations will be enforced on upload.'}</p>
        </div>
        
        <div>
          <h3>Database</h3>
          <button class="ghost" id="emptyDb">Empty Database</button>         
        </div>
        <div>
          <h3>Deploy Webhook</h3>
          <input id="deployWebhookUrl" type="text" placeholder="https://example.com/webhook" value="${state.deployWebhookUrl || ''}" />
          <div class="row">
            <button id="saveDeployWebhook" ${state.deployWebhookBusy ? 'disabled' : ''}>${state.deployWebhookBusy ? 'Saving...' : 'Save'}</button>
            <button class="ghost" id="clearDeployWebhook" ${state.deployWebhookBusy ? 'disabled' : ''}>Clear</button>
            ${state.deployWebhookMessage ? `<span class="notice">${state.deployWebhookMessage}</span>` : ''}
          </div>
          <p class="notice">Receive a POST on deploy success or failure.</p>
        </div>
        <div>
          <h3>Environment Variables</h3>
          ${isEditingEnv ? `
            <textarea id="envVars" placeholder="KEY=value\nKEY2=value2">${envText}</textarea>
            <div class="row">
              <button id="saveEnv" ${state.envBusy ? 'disabled' : ''}>${state.envBusy ? 'Saving...' : 'Save'}</button>
              <button class="ghost" id="cancelEnv">Cancel</button>
              <span class="notice">${state.envMessage || ''}</span>
            </div>
          ` : `
            <div class="env-summary">
              <p class="notice">Hidden by default for security. ${envSummary}</p>
              <div class="row">
                <button class="ghost" id="editEnv">Edit Variables</button>
                ${state.envMessage ? `<span class="notice">${state.envMessage}</span>` : ''}
              </div>
            </div>
          `}
        </div>
        ${DESKTOP_BRIDGE ? `
        <div class="card local-run">
          <h3>Local Run</h3>
          <div class="local-run-note">
            <p class="notice">Desktop tools: launch mobile simulators locally.</p>
            <div class="info-popover">
              <button class="info-icon" type="button" aria-label="Simulator visibility tip" aria-expanded="false">i</button>
              <div class="info-tooltip" role="tooltip">
                If you do not see iOS Simulator or Android Emulator appear when launched check your toolbar of running applications.
              </div>
            </div>
          </div>
          <div class="row local-run-actions">
            <button class="ghost" id="localRunIos" ${state.localRunBusy ? 'disabled' : ''}>${iosActive ? 'Stop iOS Simulator' : 'Run iOS Simulator'}</button>
            <button class="ghost" id="localRunAndroid" ${state.localRunBusy ? 'disabled' : ''}>${androidActive ? 'Stop Android Emulator' : 'Run Android Emulator'}</button>
          </div>
          ${state.localRunActive ? `<p class="notice m-top-sm">Active: ${state.localRunPlatform === 'ios' ? 'iOS Simulator' : 'Android Emulator'}</p>` : ''}
          ${state.localRunWaiting ? `
            <div class="row m-top-sm">
              <div class="spinner"></div>
              <p class="notice">${state.localRunWaitMessage || 'Waiting for simulator…'}${activeDeviceList.length ? ` Detected: ${activeDeviceList.join(', ')}.` : ''}</p>
            </div>
          ` : ''}
          ${state.localRunNotice ? `<p class="notice m-top-sm ${state.localRunNotice.includes('No Android emulator detected') ? 'notice-warning' : ''}">${state.localRunNotice}</p>` : ''}
          ${iosReady ? '' : `<p class="notice m-top-sm">iOS setup required. Click “Run iOS Simulator” to start the setup wizard.</p>`}
          ${androidReady ? '' : `<p class="notice m-top-sm">Android setup required. Click “Run Android Emulator” to start the setup wizard.</p>`}
          <pre class="local-run-log">${state.localRunLog || 'No local runs yet.'}</pre>
        </div>
        ` : ''}
      </div>
    `;
  }

  renderTasks(project) {
    const tasks = state.tasks.filter((t) => t.environment === 'development' && !t.session_id);
    const mostRecentId = tasks[0]?.id;
    const canSaveSession = tasks.length > 0;
    return `
      <div class="card">
        <div class="section-title">
          <h2>Tasks</h2>
          <div class="task-actions">
            <button id="saveSession" ${canSaveSession ? '' : 'disabled'} ${canSaveSession ? '' : 'title="Add a task before saving a session."'}>Save</button>
          </div>
        </div>
        <details open>
          <summary>Development Session</summary>
          <div class="grid">
            ${tasks.map((task) => this.renderTask(task, task.id === mostRecentId)).join('') || '<p class="notice">No tasks yet. Your build history will appear here.</p>'}
          </div>
        </details>
      </div>
    `;
  }

  renderTask(task, canDelete, sessionId = null) {
    const logState = state.taskLogs[task.id] || { open: false };
    const detailState = state.taskDetails[task.id] || { open: false };
    const isLive = task.commit_hash && task.commit_hash === state.deployedCommit[state.environment] && state.buildStatus[state.environment] === 'live';
    const isDeploying = task.commit_hash && task.commit_hash === state.pendingDeployCommit[state.environment] && state.buildStatus[state.environment] === 'building';
    const canViewLogs = isLive || isDeploying;
    const latestBuild = state.latestBuild[state.environment];
    const buildMatchesTask = latestBuild?.ref_commit
      ? latestBuild.ref_commit === task.commit_hash
      : !task.commit_hash;
    const healthFailure = buildMatchesTask ? parseHealthcheckFailure(latestBuild) : null;
    const healthText = healthFailure
      ? [healthFailure.message, healthFailure.podLogs].filter(Boolean).join('\n\n')
      : '';
    const projectName = state.projects.find((p) => p.id === state.projectId)?.name || 'Project';  
    return `
      <div class="task" data-task-id="${task.id}" ${sessionId ? `data-session-id="${sessionId}"` : ''}>
        <div class="task-header">
          <div class="meta" data-rel-time="${task.created_at || ''}">${formatRelative(task.created_at)}</div>
          <strong class="task-prompt">${task.prompt}</strong>
          <div class="row">
            <div class="badges deploy-status">
              ${isDeploying ? '<span class="badge building">deploying</span>' : ''}
               ${isLive ? '<span class="badge live">live</span>' : ''}
              ${healthFailure && !isDeploying ? '<span class="badge failed">failed</span>' : ''}
            </div>
            <div class="badges status"> 
            <span class="badge ${badgeClass(task.status)}">${task.status}</span>

              </div>
        
          </div>
        </div>
        <div class="task-actions">
         
          <button class="icon-button deploy-button" data-commit="${task.commit_hash || ''}" title="View app from this task" aria-label="View app from this task">${icon('launch')}</button>
        </div>
        ${detailState.open ? `
          <div class="task-details">
            <div class="detail-grid">
              <div class="detail-item"><span class="meta">Created</span><span>${task.created_at || '—'}</span></div>
              <div class="detail-item"><span class="meta">Completed</span><span>${task.completed_at || '—'}</span></div>
               ${canDelete ? `<button class="icon-button delete-latest-task" title="Delete latest task" aria-label="Delete latest task">${icon('trash')}</button>` : ''}
           ${canViewLogs ? `<button class="icon-button logs-button" data-scope="task" data-id="${task.id}" title="Logs" aria-label="Logs">${icon('logs')}</button>` : ''}
            </div>
            <div class="detail-block" data-field="prompt">
              <div class="detail-block-header">
                <span class="meta">Prompt</span>
                <button class="icon-button copy-task" data-field="prompt" title="Copy prompt" aria-label="Copy prompt">${icon('copy')}</button>
              </div>
              <pre class="expandable-pre">${task.prompt || '—'}</pre>
            </div>
            <div class="detail-block" data-field="summary">
              <div class="detail-block-header">
                <span class="meta">Summary</span>
                <button class="icon-button copy-task" data-field="summary" title="Copy summary" aria-label="Copy summary">${icon('copy')}</button>
              </div>
              <pre class="expandable-pre">${task.codex_output || 'No task output yet.'}</pre>
            </div>
            ${healthFailure ? `
              <div class="detail-block" data-field="healthcheck">
                <div class="detail-block-header">
                  <span class="meta">Health check failed</span>
                  <button class="icon-button copy-task" data-field="healthcheck" title="Copy logs" aria-label="Copy logs">${icon('copy')}</button>
                </div>
                <pre class="expandable-pre">${healthText || 'No logs captured.'}</pre>
              </div>
            ` : ''}
          </div>
        ` : ''}
        ${logState.open ? `
          <div class="log-panel">` +
           // <div class="log-header">Task Logs</div>
          //  <pre>${task.codex_output || 'No task output yet.'}</pre>
          ` <div class="log-header">
              <span>${projectName} Application Logs</span>
              <div class="log-actions">
                <button class="icon-button fetch-logs" data-id="${task.id}" title="Fetch latest logs" aria-label="Fetch latest logs">Fetch</button>
                <button class="icon-button copy-logs" data-id="${task.id}" title="Copy Application Logs" aria-label="Copy Application Logs">${icon('copy')}</button>
              </div>
            </div>
            <pre class="expandable-pre">${logState.loading ? 'Loading...' : (logState.serverLog || logState.error || 'No server log yet.')}</pre>
            <button class="ghost refresh-logs" data-id="${task.id}">Refresh</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  renderSavedSessions(project, isDev) {
    const sessions = state.sessions.filter((s) => s.merge_commit);
    return `
      <div class="card">
        <div class="section-title">
          <h2>Saved Sessions</h2>
          ${isDev ? '' : `
            <a class="tag view-project-link" href="${projectProtocol()}://${projectUrl(project, state.environment)}" target="_blank" rel="noreferrer">View your project</a>
          `}
        </div>
        <div class="grid">
          ${sessions.map((session) => this.renderSession(session, isDev)).join('') || '<p class="notice">No saved sessions yet. Save milestones to build a launch-ready roadmap.</p>'}
        </div>
      </div>
    `;
  }

  renderSession(session, isDev) {
    const tasks = state.tasks.filter((t) => t.session_id === session.id);
    const tasksHtml = tasks.map((task) => this.renderTask(task, false, session.id)).join('') || '<p class="notice">No tasks in this session.</p>';
    const label = session.message.length > 40 ? `${session.message.slice(0, 40)}...` : session.message;
    const isLive = session.merge_commit && session.merge_commit === state.deployedCommit[state.environment] && state.buildStatus[state.environment] === 'live';
    const isDeploying = session.merge_commit && session.merge_commit === state.pendingDeployCommit[state.environment] && state.buildStatus[state.environment] === 'building';
    const canViewLogs = isLive || isDeploying;
    const logState = state.taskLogs[session.id] || { open: false };
    const detailsState = state.sessionDetails[session.id] || { open: false };
    const latestBuild = state.latestBuild[state.environment];
    const buildMatchesSession = latestBuild?.ref_commit
      ? latestBuild.ref_commit === session.merge_commit
      : false;
    const healthFailure = buildMatchesSession ? parseHealthcheckFailure(latestBuild) : null;
    const healthText = healthFailure
      ? [healthFailure.message, healthFailure.podLogs].filter(Boolean).join('\n\n')
      : '';
    const projectName = state.projects.find((p) => p.id === state.projectId)?.name || 'Project';
    return `
      <div class="session" data-session-id="${session.id}">
        <div class="session-header">
          <div>
            <div class="meta" data-rel-time="${session.created_at || ''}">${formatRelative(session.created_at)}</div>
            <strong>${session.message}</strong>
            ${isDeploying ? '<span class="badge building">deploying</span>' : ''}
            ${isLive ? '<span class="badge live">live</span>' : ''}
            ${healthFailure ? '<span class="badge failed">healthcheck failed</span>' : ''}
          </div>
          <div class="task-actions">
            <button class="icon-button deploy-button" data-commit="${session.merge_commit || ''}" title="View app from this saved session" aria-label="View app from this saved session">${icon('launch')}</button>
            ${canViewLogs ? `<button class="icon-button logs-button" data-scope="session" data-id="${session.id}" title="Logs" aria-label="Logs">${icon('logs')}</button>` : ''}
          </div>
        </div>
        ${isDev && detailsState.open ? `
          <div class="task-details">
            <div class="detail-grid">
              <div class="detail-item"><span class="meta"></span><span>${formatDate(session.created_at)}</span></div>
            </div> 
            <div class="grid">${tasksHtml}</div>
            ${healthFailure ? `
              <div class="detail-block" data-field="healthcheck">
                <div class="detail-block-header">
                  <span class="meta">Health check failed</span>
                  <button class="icon-button copy-task" data-field="healthcheck" title="Copy logs" aria-label="Copy logs">${icon('copy')}</button>
                </div>
                <pre class="expandable-pre">${healthText || 'No logs captured.'}</pre>
              </div>
            ` : ''}
          </div>
        ` : ''}
        ${logState.open ? `
          <div class="log-panel">
            <div class="log-header">
              <span>${projectName} Application Logs</span>
              <div class="log-actions">
                <button class="icon-button fetch-logs" data-id="${session.id}" title="Fetch latest logs" aria-label="Fetch latest logs">Fetch</button>
                <button class="icon-button copy-logs" data-id="${session.id}" title="Copy Application Logs" aria-label="Copy Application Logs">${icon('copy')}</button>
              </div>
            </div>
            <pre class="expandable-pre">${logState.loading ? 'Loading...' : (logState.serverLog || logState.error || 'No server log yet.')}</pre>
            <button class="ghost refresh-logs" data-id="${session.id}">Refresh</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  renderModal() {
    return `
      <div class="modal" id="saveModal">
        <div class="modal-content">
          <h3>Save Development Session</h3>
          <input id="saveMessage" type="text" placeholder="Summary of this session" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
          <div class="row">
            <button id="confirmSave">Save</button>
            <button class="ghost" id="cancelSave">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  renderConfirmModal() {
    return `
      <div class="modal ${state.confirmOpen ? 'open' : ''}" id="confirmModal">
        <div class="modal-content">
          <h3>Confirm</h3>
          <p class="notice">${state.confirmMessage || ''}</p>
          <div class="row">
            <button id="confirmModalConfirm">${state.confirmConfirmText || 'Confirm'}</button>
            <button class="ghost" id="confirmModalCancel">${state.confirmCancelText || 'Cancel'}</button>
          </div>
        </div>
      </div>
    `;
  }

  renderPromptModal() {
    return `
      <div class="modal ${state.promptOpen ? 'open' : ''}" id="promptModal">
        <div class="modal-content">
          <h3>Input Required</h3>
          <p class="notice">${state.promptMessage || ''}</p>
          <input id="promptModalInput" type="text" placeholder="${state.promptPlaceholder || ''}" value="${state.promptValue || ''}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
          <div class="row">
            <button id="promptModalConfirm">${state.promptConfirmText || 'Save'}</button>
            <button class="ghost" id="promptModalCancel">${state.promptCancelText || 'Cancel'}</button>
          </div>
        </div>
      </div>
    `;
  }

  renderAndroidSetupModal() {
    const status = state.androidSetupStatus || {};
    const step1Done = Boolean(status.studio_installed);
    const step2Done = Boolean(status.sdkmanager && status.emulator && status.adb);
    const pathDone = Boolean(status.adb_in_path && status.emulator_in_path);
    const javaDone = Boolean(status.java_ok);
    const step3Done = Array.isArray(status.avds) && status.avds.length > 0;
    const step4Done = hasAndroidDevice(status);
    const currentStep = state.androidSetupStep || nextAndroidSetupStep(status);
    const nextLabel = currentStep >= 5 ? 'Finish' : 'Next';
    const nextDisabled = state.androidSetupBusy ? 'disabled' : '';
    const steps = [
      { id: 1, title: 'Install Android Studio', done: step1Done },
      { id: 2, title: 'Install SDK Tools', done: step2Done },
      { id: 3, title: 'Create Emulator', done: step3Done },
      { id: 4, title: 'Emulator Window', done: Boolean(state.desktopSettings?.androidEmulatorWindowConfigured) },
      { id: 5, title: 'Run Emulator', done: step4Done }
    ];
    return `
      <div class="modal ${state.androidSetupOpen ? 'open' : ''}" id="androidSetupModal">
        <div class="modal-content android-setup-modal">
          <div class="row space-between">
            <h3>Android Setup Wizard</h3>
            <button class="ghost" id="androidSetupClose">Close</button>
          </div>
          <p class="notice">Follow the steps in order. We will check what is already installed and skip steps that are complete.</p>
          <div class="wizard-grid">
            <div class="wizard-steps">
              ${steps.map((step) => `
                <div class="wizard-step${step.done ? ' done' : ''}${step.id === currentStep ? ' active' : ''}">
                  <div class="step-index">${step.id}</div>
                  <div class="step-label">
                    <div class="step-title">${step.title}</div>
                    <div class="notice">${step.done ? 'Complete' : 'Required'}</div>
                  </div>
                </div>
              `).join('')}
            </div>
            <div class="wizard-panel">
              ${currentStep === 1 ? `
                <h4>Install Android Studio</h4>
                <p class="notice">Android Studio provides the SDK, emulator, and tooling.</p>
                <p class="notice">After installing, open Android Studio manually from Applications.</p>
                <div class="row">
                  <button class="ghost" id="androidWizardInstall">Open Android Studio Download</button>
                </div>
              ` : ''}
              ${currentStep === 2 ? `
                <h4>Install SDK Tools</h4>
                <p class="notice">Open Android Studio manually, then Settings (${settingsShortcutLabel()}) → Languages & Frameworks → Android SDK → SDK Tools.</p>
                <p class="notice">Check: Android SDK Command-line Tools (latest), Android Emulator, Android SDK Platform-Tools.</p>
                <p class="notice">PATH: ${pathDone ? 'Configured' : 'Not set'}.</p>
                <p class="notice">Java: ${javaDone ? 'Configured' : 'Not set'}.</p>
                <div class="row">
                  <button id="androidWizardConfigure" ${state.androidSetupBusy ? 'disabled' : ''}>${state.androidSetupBusy ? 'Configuring...' : 'Configure SDK'}</button>
                  <button class="ghost" id="androidWizardPath" ${state.androidSetupBusy ? 'disabled' : ''}>Add SDK to PATH</button>
                </div>
              ` : ''}
              ${currentStep === 3 ? `
                <h4>Create Emulator</h4>
                <p class="notice">We will create a default emulator once SDK tools are installed.</p>
                <div class="row">
                  <button id="androidWizardConfigure" ${state.androidSetupBusy ? 'disabled' : ''}>${state.androidSetupBusy ? 'Configuring...' : 'Create Emulator'}</button>
                </div>
              ` : ''}
              ${currentStep === 4 ? `
                <h4>Emulator Window</h4>
                <p class="notice">Set the emulator to launch in a separate window.</p>
                <p class="notice">Android Studio → Settings → Tools → Emulator → Uncheck “Launch in the Running Devices tool window”.</p>
              ` : ''}
              ${currentStep === 5 ? `
                <h4>Run Android Emulator</h4>
                ${step4Done ? `
                  <p class="notice">Detected device: ${status.devices.join(', ')}.</p>
                  <p class="notice">Close this wizard and click “Run Android Emulator”.</p>
                ` : `
                  <p class="notice">No running emulator detected yet.</p>
                  <p class="notice">Open Android Studio manually and open any project (even a blank one) so the top Tools menu appears.</p>
                  <p class="notice">Then go to Tools → Device Manager and click the ▶ play button next to a device to start it.</p>
                  <p class="notice">If you don’t see Device Manager, try View → Tool Windows → Device Manager or open the “Emulator” tool window.</p>
                `}
              ` : ''}

              <div class="row wizard-actions">
                <button class="ghost" id="androidWizardBack" ${currentStep <= 1 ? 'disabled' : ''}>Back</button>
                <button id="androidWizardNext" ${nextDisabled}>${state.androidSetupBusy && currentStep >= 5 ? 'Checking...' : nextLabel}</button>
              </div>
              ${state.androidSetupMessage ? `<p class="notice wizard-message">${state.androidSetupMessage}</p>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderIosSetupModal() {
    const status = state.iosSetupStatus || {};
    const supported = status.supported !== false;
    const step1Done = Boolean(status.xcode_installed);
    const step2Done = Boolean(status.xcode_license);
    const step3Done = Array.isArray(status.simulators) && status.simulators.length > 0;
    const currentStep = state.iosSetupStep || nextIosSetupStep(status);
    const steps = [
      { id: 1, title: 'Install Xcode', done: step1Done },
      { id: 2, title: 'Finish Xcode Setup', done: step2Done },
      { id: 3, title: 'Add Simulator', done: step3Done },
      { id: 4, title: 'Run Simulator', done: step1Done && step2Done && step3Done }
    ];
    return `
      <div class="modal ${state.iosSetupOpen ? 'open' : ''}" id="iosSetupModal">
        <div class="modal-content ios-setup-modal">
          <div class="row space-between">
            <h3>iOS Setup Wizard</h3>
            <button class="ghost" id="iosSetupClose">Close</button>
          </div>
          <p class="notice">Follow the steps in order. We will check what is already installed and skip steps that are complete.</p>
          ${supported ? '' : `<p class="notice">iOS Simulator is only available on macOS.</p>`}
          <div class="wizard-grid">
            <div class="wizard-steps">
              ${steps.map((step) => `
                <div class="wizard-step${step.done ? ' done' : ''}${step.id === currentStep ? ' active' : ''}">
                  <div class="step-index">${step.id}</div>
                  <div class="step-label">
                    <div class="step-title">${step.title}</div>
                    <div class="notice">${step.done ? 'Complete' : 'Required'}</div>
                  </div>
                </div>
              `).join('')}
            </div>
            <div class="wizard-panel">
              ${currentStep === 1 ? `
                <h4>Install Xcode</h4>
                <p class="notice">Install Xcode from the Mac App Store.</p>
                <div class="row">
                  <button class="ghost" id="iosWizardInstall">Open Xcode in App Store</button>
                </div>
              ` : ''}
              ${currentStep === 2 ? `
                <h4>Finish Xcode Setup</h4>
                <p class="notice">Open Xcode manually from Applications and finish the first-run setup. Accept the license if prompted.</p>
                <p class="notice">If asked in Terminal, run: <code>sudo xcodebuild -license</code>.</p>
              ` : ''}
              ${currentStep === 3 ? `
                <h4>Add Simulator</h4>
                <p class="notice">Open Xcode manually, then Window → Devices and Simulators → Simulators tab → + to add a device.</p>
              ` : ''}
              ${currentStep === 4 ? `
                <h4>Run iOS Simulator</h4>
                <p class="notice">Setup complete. Close this wizard and click “Run iOS Simulator”.</p>
              ` : ''}

              <div class="row wizard-actions">
                <button class="ghost" id="iosWizardBack" ${currentStep <= 1 ? 'disabled' : ''}>Back</button>
                <button id="iosWizardNext" ${currentStep >= 4 || !supported ? 'disabled' : ''}>Next</button>
              </div>
              ${state.iosSetupMessage ? `<p class="notice wizard-message">${state.iosSetupMessage}</p>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderDeletingModal() {
    return `
      <div class="modal ${state.deletingProject ? 'open' : ''}" id="deletingModal">
        <div class="modal-content">
          <h3>Deleting Project</h3>
          <p class="notice">Cleaning up snapshots, environments, and runtime resources. Please wait.</p>
          <div class="spinner" aria-hidden="true"></div>
        </div>
      </div>
    `;
  }

  renderSettings() {
    const defaults = {
      healthcheck_path: '/',
      healthcheck_path_dev: '',
      healthcheck_path_test: '',
      healthcheck_path_prod: '',
      healthcheck_protocol: '',
      healthcheck_protocol_dev: '',
      healthcheck_protocol_test: '',
      healthcheck_protocol_prod: '',
      healthcheck_timeout_ms: '60000',
      healthcheck_interval_ms: '3000'
    };
    const isOver = (key) => (state.healthSettings[key] || '') !== (defaults[key] || '');
    const badge = (key) => isOver(key) ? '<span class="tag override">Overridden</span>' : '<span class="tag">Default</span>';
    const project = state.projects.find((p) => p.id === state.projectId);
    const webEnabled = project?.interface_web !== false;
    const mobileEnabled = Boolean(project?.interface_mobile);
    const mobileStackType = project?.mobile_stack_type || 'expo';
    const desktopSettings = state.desktopSettings || {};
    return `
      <div class="modal ${state.settingsOpen ? 'open' : ''}" id="settingsModal">
        <div class="modal-content">
          <h3>Project Settings</h3>
          ${project ? `
            <div class="grid">
              <label for="projectNameInput" class="tag">Project Name</label>
              <input id="projectNameInput" placeholder="Project name" value="${project.name}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
              <div class="row">
                <button id="renameProject">Update Name</button>
                <button class="danger" id="deleteProject">Delete Project</button>
              </div>
            </div>
            <div class="grid m-top-sm">
              <label class="tag">Interfaces</label>
              <div class="interface-choice">
                <label class="checkbox">
                  <input id="projectInterfaceWeb" type="checkbox" ${webEnabled ? 'checked' : ''} />
                  <span>Web App</span>
                </label>
                <label class="checkbox">
                  <input id="projectInterfaceMobile" type="checkbox" ${mobileEnabled ? 'checked' : ''} />
                  <span>Mobile App</span>
                </label>
              </div>
              ${mobileEnabled ? `
                <div class="interface-stack">
                  <label class="tag">Mobile Stack</label>
                  <div class="stack-options">
                    <label class="radio">
                      <input type="radio" name="projectMobileStack" value="expo" ${mobileStackType === 'expo' ? 'checked' : ''} />
                      <span>Quick Setup with Expo (Recommended)</span>
                    </label>
                    <label class="radio">
                      <input type="radio" name="projectMobileStack" value="rn_cli" ${mobileStackType === 'rn_cli' ? 'checked' : ''} />
                      <span>Detailed Setup and Control with React Native CLI (Advanced)</span>
                    </label>
                  </div>
                </div>
              ` : ''}
              <div class="row">
                <button id="updateProjectInterfaces">Update Interfaces</button>
              </div>
            </div>
          ` : '<p class="notice">Select a project to edit settings.</p>'}

          <h3>Appearance</h3>
          <div class="setting-row toggle-row">
            <span class="tag">Theme</span>
            <label class="toggle">
              <input id="darkModeToggle" type="checkbox" ${state.darkMode ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">Dark mode</span>
            </label>
          </div>
          ${state.demoMode ? `
          <h3>OpenAI API Key</h3>
          <p class="notice">Used for tasks while demo mode is enabled.</p>
          <div class="setting-row">
            <span class="tag">OpenAI API Key</span>
            <input id="demoOpenAiKey" type="password" placeholder="sk-..." value="${state.demoOpenAiKey || ''}" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" />
          </div>
          ` : ''}
          ${DESKTOP_BRIDGE ? `
          <h3>Desktop Local Dev</h3>
          <p class="notice">Default is AWS. Enable local API only when you want to run the server on your machine.</p>
          <div class="setting-row toggle-row">
            <span class="tag">Use Local API</span>
            <label class="toggle">
              <input id="desktopUseLocalApi" type="checkbox" ${desktopSettings.useLocalApi ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">Local</span>
            </label>
          </div>
          <div class="setting-row">
            <span class="tag">Local API URL</span>
            <input id="desktopLocalApiUrl" placeholder="http://localhost:4000" value="${desktopSettings.localApiUrl || ''}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="setting-row">
            <span class="tag">iOS Command</span>
            <input id="desktopIosCommand" placeholder="npx expo run:ios" value="${desktopSettings.iosCommand || ''}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="setting-row">
            <span class="tag">Android Command</span>
            <input id="desktopAndroidCommand" placeholder="npx expo run:android" value="${desktopSettings.androidCommand || ''}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
          </div>
          ` : ''}
            ${false ? `
          <h3>Health Checks</h3>
          <p class="notice">Defaults: path /, timeout 60000ms, interval 3000ms, protocol http for local and https in production.</p>
          <div class="grid">
            <div class="setting-row">${badge('healthcheck_path')}<input class="${isOver('healthcheck_path') ? 'overridden' : ''}" id="hc_path" placeholder="/" value="${state.healthSettings.healthcheck_path || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_path_dev')}<input class="${isOver('healthcheck_path_dev') ? 'overridden' : ''}" id="hc_path_dev" placeholder="Dev path override" value="${state.healthSettings.healthcheck_path_dev || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_path_test')}<input class="${isOver('healthcheck_path_test') ? 'overridden' : ''}" id="hc_path_test" placeholder="Test path override" value="${state.healthSettings.healthcheck_path_test || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_path_prod')}<input class="${isOver('healthcheck_path_prod') ? 'overridden' : ''}" id="hc_path_prod" placeholder="Prod path override" value="${state.healthSettings.healthcheck_path_prod || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_protocol')}<input class="${isOver('healthcheck_protocol') ? 'overridden' : ''}" id="hc_proto" placeholder="Protocol override (http/https)" value="${state.healthSettings.healthcheck_protocol || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_protocol_dev')}<input class="${isOver('healthcheck_protocol_dev') ? 'overridden' : ''}" id="hc_proto_dev" placeholder="Dev protocol override" value="${state.healthSettings.healthcheck_protocol_dev || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_protocol_test')}<input class="${isOver('healthcheck_protocol_test') ? 'overridden' : ''}" id="hc_proto_test" placeholder="Test protocol override" value="${state.healthSettings.healthcheck_protocol_test || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_protocol_prod')}<input class="${isOver('healthcheck_protocol_prod') ? 'overridden' : ''}" id="hc_proto_prod" placeholder="Prod protocol override" value="${state.healthSettings.healthcheck_protocol_prod || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_timeout_ms')}<input class="${isOver('healthcheck_timeout_ms') ? 'overridden' : ''}" id="hc_timeout" placeholder="Timeout ms" value="${state.healthSettings.healthcheck_timeout_ms || ''}" /></div>
            <div class="setting-row">${badge('healthcheck_interval_ms')}<input class="${isOver('healthcheck_interval_ms') ? 'overridden' : ''}" id="hc_interval" placeholder="Interval ms" value="${state.healthSettings.healthcheck_interval_ms || ''}" /></div>
          </div>
          `: ''}
          <div class="row m-top-sm">
            <button id="saveSettings" ${state.settingsBusy ? 'disabled' : ''}>${state.settingsBusy ? 'Saving...' : 'Save'}</button>
            <button class="ghost" id="resetSettings">Reset</button>
            <button class="ghost" id="closeSettings">Close</button>
            <span class="notice">${state.settingsMessage || ''}</span>
          </div>
        </div>
      </div>
    `;
  }

  bind() {
    // Expand/collapse for prompt/response <pre>
    this.querySelectorAll('.expandable-pre').forEach((pre) => {
      pre.addEventListener('click', (event) => {
        event.stopPropagation();
        pre.classList.toggle('expanded');
      });
    });
    this.querySelectorAll('.info-popover').forEach((wrap) => {
      const btn = wrap.querySelector('.info-icon');
      if (!btn) return;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const isOpen = wrap.classList.contains('open');
        this.querySelectorAll('.info-popover.open').forEach((el) => {
          el.classList.remove('open');
          const toggle = el.querySelector('.info-icon');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          wrap.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
    if (!this._infoPopoverBound) {
      this._infoPopoverBound = true;
      document.addEventListener('click', (event) => {
        if (!this.contains(event.target)) return;
        if (event.target.closest('.info-popover')) return;
        this.querySelectorAll('.info-popover.open').forEach((el) => {
          el.classList.remove('open');
          const toggle = el.querySelector('.info-icon');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
      });
    }
    this.querySelectorAll('.view-project-link').forEach((link) => {
      link.addEventListener('click', (event) => {
        if (!DESKTOP_BRIDGE) return;
        event.preventDefault();
        openExternalLink(link.getAttribute('href'));
      });
    });
    this.querySelector('#logout')?.addEventListener('click', () => {
      localStorage.removeItem('vibes_token');
      const key = projectStorageKey(state.user?.id);
      if (key) localStorage.removeItem(key);
      if (socketClient) {
        socketClient.disconnect();
        socketClient = null;
        socketProjectId = null;
      }
      stopRuntimeUsagePolling();
      setState({
        token: '',
        user: null,
        projects: [],
        projectId: null,
        projectsLoaded: false,
        projectsLoading: false,
        projectsError: '',
        desktopSettings: loadDesktopSettings(null),
        runtimeUsage: { month: '', plan: '', usage: {} },
        runtimeUsageLoading: false,
        runtimeUsageError: '',
        runtimeQuotaNotice: {}
      });
    });

    this.querySelector('#openSettings')?.addEventListener('click', async () => {
      setState({ settingsOpen: true, settingsMessage: '' });
      await loadHealthSettings();
      await loadDemoSettings();
    });

    this.querySelector('#closeSettings')?.addEventListener('click', () => {
      setState({ settingsOpen: false });
    });

    this.querySelector('#retryProjects')?.addEventListener('click', async () => {
      setState({ projectsLoaded: false, projectsError: '' });
      await loadProjects();
    });

    this.querySelector('#saveSettings')?.addEventListener('click', async () => {
      const payload = {};
      const hcPath = this.querySelector('#hc_path');
      const hcPathDev = this.querySelector('#hc_path_dev');
      const hcPathTest = this.querySelector('#hc_path_test');
      const hcPathProd = this.querySelector('#hc_path_prod');
      const hcProto = this.querySelector('#hc_proto');
      const hcProtoDev = this.querySelector('#hc_proto_dev');
      const hcProtoTest = this.querySelector('#hc_proto_test');
      const hcProtoProd = this.querySelector('#hc_proto_prod');
      const hcTimeout = this.querySelector('#hc_timeout');
      const hcInterval = this.querySelector('#hc_interval');
      const desktopUseLocalApi = this.querySelector('#desktopUseLocalApi');
      const desktopLocalApiUrl = this.querySelector('#desktopLocalApiUrl');
      const desktopIosCommand = this.querySelector('#desktopIosCommand');
      const desktopAndroidCommand = this.querySelector('#desktopAndroidCommand');
      if (hcPath) payload.healthcheck_path = hcPath.value;
      if (hcPathDev) payload.healthcheck_path_dev = hcPathDev.value;
      if (hcPathTest) payload.healthcheck_path_test = hcPathTest.value;
      if (hcPathProd) payload.healthcheck_path_prod = hcPathProd.value;
      if (hcProto) payload.healthcheck_protocol = hcProto.value;
      if (hcProtoDev) payload.healthcheck_protocol_dev = hcProtoDev.value;
      if (hcProtoTest) payload.healthcheck_protocol_test = hcProtoTest.value;
      if (hcProtoProd) payload.healthcheck_protocol_prod = hcProtoProd.value;
      if (hcTimeout) payload.healthcheck_timeout_ms = hcTimeout.value;
      if (hcInterval) payload.healthcheck_interval_ms = hcInterval.value;
      const demoKeyEl = this.querySelector('#demoOpenAiKey');
      const demoKey = demoKeyEl ? demoKeyEl.value.trim() : '';
      const saveCalls = [];
      if (Object.keys(payload).length > 0) {
        saveCalls.push(api('/settings/healthcheck', { method: 'PUT', body: JSON.stringify(payload) }));
      }
      if (demoKeyEl) {
        saveCalls.push(api('/settings/demo-openai-key', { method: 'PUT', body: JSON.stringify({ openaiApiKey: demoKey }) }));
      }
      setState({ settingsBusy: true, settingsMessage: 'Saving...' });
      try {
        if (saveCalls.length > 0) {
          await Promise.all(saveCalls);
        }
        if (demoKeyEl) {
          setState({ demoOpenAiKey: demoKey });
        }
        if (DESKTOP_BRIDGE) {
          const nextDesktopSettings = {
            ...state.desktopSettings,
            useLocalApi: Boolean(desktopUseLocalApi?.checked),
            localApiUrl: desktopLocalApiUrl?.value.trim() || '',
            iosCommand: desktopIosCommand?.value.trim() || '',
            androidCommand: desktopAndroidCommand?.value.trim() || ''
          };
          saveDesktopSettings(state.user?.id, nextDesktopSettings);
          setState({ desktopSettings: nextDesktopSettings });
          if (socketClient) {
            socketClient.disconnect();
            socketClient = null;
            connectSocket(state.projectId);
          }
        }
        setState({ settingsMessage: 'Saved' });
      } catch (err) {
        setState({ settingsMessage: err.message });
      } finally {
        setState({ settingsBusy: false });
      }
    });

    const confirmModal = this.querySelector('#confirmModal');
    const closeConfirm = (confirmed) => {
      if (confirmResolver) confirmResolver(Boolean(confirmed));
      confirmResolver = null;
      setState({ confirmOpen: false });
    };
    this.querySelector('#confirmModalConfirm')?.addEventListener('click', () => closeConfirm(true));
    this.querySelector('#confirmModalCancel')?.addEventListener('click', () => closeConfirm(false));
    confirmModal?.addEventListener('click', (event) => {
      if (event.target === confirmModal) closeConfirm(false);
    });

    const promptModal = this.querySelector('#promptModal');
    const closePrompt = (value) => {
      if (promptResolver) promptResolver(value);
      promptResolver = null;
      setState({ promptOpen: false, promptValue: '' });
    };
    this.querySelector('#promptModalConfirm')?.addEventListener('click', () => {
      const value = this.querySelector('#promptModalInput')?.value || '';
      closePrompt(value);
    });
    this.querySelector('#promptModalCancel')?.addEventListener('click', () => closePrompt(null));
    this.querySelector('#promptModalInput')?.addEventListener('input', (event) => {
      state.promptValue = event.target.value;
    });
    promptModal?.addEventListener('click', (event) => {
      if (event.target === promptModal) closePrompt(null);
    });

    this.querySelector('#resetSettings')?.addEventListener('click', async () => {
      const ok = await showConfirm('Reset healthcheck settings to defaults?', { confirmText: 'Reset' });
      if (!ok) return;
      setState({ settingsBusy: true, settingsMessage: 'Resetting...' });
      try {
        await api('/settings/healthcheck', { method: 'DELETE' });
        await loadHealthSettings();
        setState({ settingsMessage: 'Reset to defaults' });
      } catch (err) {
        setState({ settingsMessage: err.message });
      } finally {
        setState({ settingsBusy: false });
      }
    });

    this.querySelector('#darkModeToggle')?.addEventListener('change', (event) => {
      const enabled = event.target.checked;
      localStorage.setItem('vibes_dark_mode', enabled ? 'true' : 'false');
      setState({ darkMode: enabled });
    });

    this.querySelector('#loginBtn')?.addEventListener('click', async () => {
      const email = this.querySelector('#loginEmail').value;
      const password = this.querySelector('#loginPassword').value;
      try {
        const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        localStorage.setItem('vibes_token', data.token);
        setState({ token: data.token, user: data.user, desktopSettings: loadDesktopSettings(data.user?.id) });
        await loadProjects();
        connectSocket(state.projectId);
      } catch (err) {
        showError(err);
      }
    });

    this.querySelector('#registerBtn')?.addEventListener('click', async () => {
      const email = this.querySelector('#registerEmail').value;
      const password = this.querySelector('#registerPassword').value;
      try {
        const data = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
        localStorage.setItem('vibes_token', data.token);
        setState({ token: data.token, user: data.user, desktopSettings: loadDesktopSettings(data.user?.id) });
        await loadProjects();
        connectSocket(state.projectId);
      } catch (err) {
        showError(err);
      }
    });

    const authModal = this.querySelector('.auth-modal');
    if (authModal) {
      const panels = Array.from(authModal.querySelectorAll('.auth-panel'));
      const setPanel = (mode) => {
        panels.forEach((panel) => {
          panel.style.display = panel.getAttribute('data-auth-panel') === mode ? 'block' : 'none';
        });
      };
      const closeAuth = () => {
        authModal.classList.remove('open');
        authModal.setAttribute('aria-hidden', 'true');
      };
      const openAuth = (mode) => {
        setPanel(mode);
        authModal.classList.add('open');
        authModal.setAttribute('aria-hidden', 'false');
      };

      // Ensure the modal is closed on initial render.
      closeAuth();
      setPanel('register');

      this.querySelectorAll('[data-auth-target]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          const mode = btn.getAttribute('data-auth-target') || 'register';
          openAuth(mode);
        });
      });

      authModal.querySelector('.auth-close')?.addEventListener('click', closeAuth);
      authModal.addEventListener('click', (event) => {
        if (event.target === authModal) closeAuth();
      });
    }

    this.querySelector('#projectSelect')?.addEventListener('change', async (e) => {
      const projectId = e.target.value;
      if (projectId === '__new__') {
        setState({
          projectId: null,
          environment: 'development',
          nerdLevel: 'beginner',
          lastSuccessBuild: { development: null, testing: null, production: null },
          failedBuildLog: { development: null, testing: null, production: null },
          failedBuildLogVisible: { development: false, testing: false, production: false },
          failedBuildLogLoading: { development: false, testing: false, production: false },
          failedBuildLogError: { development: '', testing: '', production: '' },
          failedBuildLogLines: { development: 200, testing: 200, production: 200 },
          deployWebhookUrl: '',
          deployWebhookMessage: ''
        });
        localStorage.setItem('vibes_nerd_level', 'beginner');
        const key = projectStorageKey(state.user?.id);
        if (key) localStorage.removeItem(key);
        return;
      }
      const storedEnv = loadStoredEnv(state.user?.id, projectId);
      storeProject(state.user?.id, projectId);
      setState({
        projectId,
        environment: storedEnv || state.environment,
        envEditing: { development: false, testing: false, production: false },
        envMessage: '',
        failedBuildLog: { development: null, testing: null, production: null },
        failedBuildLogVisible: { development: false, testing: false, production: false },
        failedBuildLogLoading: { development: false, testing: false, production: false },
        failedBuildLogError: { development: '', testing: '', production: '' },
        failedBuildLogLines: { development: 200, testing: 200, production: 200 },
        deployWebhookMessage: ''
      });
      await loadTasks(projectId);
      await loadSessions(projectId);
      await loadEnvVars(projectId, state.environment);
      await loadLatestBuild(projectId, state.environment);
      await loadLastSuccessBuilds(projectId);
      await loadDeployWebhook(projectId);
      connectSocket(projectId);
      if (DESKTOP_BRIDGE && projectId) {
        // repo sync happens only when running mobile simulators
      }
    });

    this.querySelector('#createProjectBtn')?.addEventListener('click', async () => {
      const name = this.querySelector('#createProjectName')?.value?.trim();
      if (!name) return setTaskStatus('Enter a project name', { autoHide: true });
      if (name.length > 30) {
        return setTaskStatus('Project name must be 30 characters or fewer', { autoHide: true });
      }
      if (isProjectNameTaken(name)) return setTaskStatus('Project name already exists', { autoHide: true });
      try {
        const interfaces = [];
        if (state.createInterfaces.web) interfaces.push('web');
        if (state.createInterfaces.mobile) interfaces.push('mobile');
        const mobileStackType = state.createProjectStack || 'expo';
        const project = await api('/projects', {
          method: 'POST',
          body: JSON.stringify({ name, interfaces, mobileStackType })
        });
        await loadProjects();
        storeEnv(state.user?.id, project.id, 'development');
        setState({ projectId: project.id, environment: 'development', nerdLevel: 'beginner', createProjectName: '' });
        localStorage.setItem('vibes_nerd_level', 'beginner');
        connectSocket(project.id);
        if (DESKTOP_BRIDGE && project.id) {
          // repo sync happens only when running mobile simulators
        }
      } catch (err) {
        if (String(err.message || '').toLowerCase().includes('already exists')) {
          setTaskStatus('Project name already exists. Please choose another.', { autoHide: true });
          return;
        }
        showError(err);
      }
    });

    this.querySelector('#createProjectName')?.addEventListener('input', (event) => {
      state.createProjectName = event.target.value || '';
    });

    this.querySelector('#createInterfaceWeb')?.addEventListener('change', (event) => {
      state.createInterfaces.web = event.target.checked;
      if (!state.createInterfaces.web && !state.createInterfaces.mobile) {
        state.createInterfaces.web = true;
      }
      setState({ createInterfaces: { ...state.createInterfaces } });
    });

    this.querySelector('#createInterfaceMobile')?.addEventListener('change', (event) => {
      state.createInterfaces.mobile = event.target.checked;
      if (!state.createInterfaces.web && !state.createInterfaces.mobile) {
        state.createInterfaces.mobile = true;
      }
      setState({ createInterfaces: { ...state.createInterfaces } });
    });

    this.querySelectorAll('input[name="mobileStack"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        state.createProjectStack = event.target.value;
      });
    });

    this.querySelector('.content')?.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('pre') || e.target.closest('a') || e.target.closest('input') || e.target.closest('textarea') || e.target.closest('select')) {
        return;
      }

      const taskEl = e.target.closest('.task');
      if (taskEl) {
        e.stopPropagation();
        const id = taskEl.getAttribute('data-task-id');
        if (!id) return;
        const sessionId = taskEl.getAttribute('data-session-id');
        const current = state.taskDetails[id] || { open: false };
        state.taskDetails[id] = { ...current, open: !current.open };
        if (sessionId) {
          state.sessionDetails[sessionId] = { open: true };
        }
        setState({
          taskDetails: { ...state.taskDetails },
          sessionDetails: { ...state.sessionDetails }
        });
        return;
      }

      const sessionEl = e.target.closest('.session');
      if (!sessionEl) return;
      e.stopPropagation();
      const sessionId = sessionEl.getAttribute('data-session-id');
      if (!sessionId) return;
      const current = state.sessionDetails[sessionId] || { open: false };
      state.sessionDetails[sessionId] = { ...current, open: !current.open };
      setState({ sessionDetails: { ...state.sessionDetails } });
    }, true);

    this.querySelector('#deleteProject')?.addEventListener('click', async () => {
      const project = state.projects.find((p) => p.id === state.projectId);
      if (!project) return;
      const ok = await showConfirm(
        `Delete "${project.name}"? This removes snapshots, envs, builds, DBs, and runtime resources.`,
        { confirmText: 'Delete' }
      );
      if (!ok) return;
      setState({
        deletingProject: true,
        settingsOpen: false,
        projectsError: ''
      });
      try {
        await api(`/projects/${project.id}`, { method: 'DELETE' });
        const remaining = state.projects.filter((p) => p.id !== project.id);
        const nextProjectId = remaining[0]?.id || null;
        if (nextProjectId) {
          storeProject(state.user?.id, nextProjectId);
        } else {
          const key = projectStorageKey(state.user?.id);
          if (key) localStorage.removeItem(key);
        }
        setState({
          projects: remaining,
          projectId: nextProjectId,
          projectsLoaded: true,
          projectsLoading: false,
          envEditing: { development: false, testing: false, production: false },
          envMessage: ''
        });
        if (!nextProjectId) {
          setState({
            tasks: [],
            sessions: [],
            envVars: {},
            buildStatus: { development: 'offline', testing: 'offline', production: 'offline' },
            deployedCommit: { development: '', testing: '', production: '' },
            pendingDeployCommit: { development: '', testing: '', production: '' },
            progressVisibleUntil: { development: 0, testing: 0, production: 0 },
            updatedAt: { development: '', testing: '', production: '' },
            environment: 'development',
            nerdLevel: 'beginner'
          });
          return;
        }
        const storedEnv = loadStoredEnv(state.user?.id, nextProjectId);
        setState({ environment: storedEnv || state.environment });
        await loadTasks(nextProjectId);
        await loadSessions(nextProjectId);
        await loadEnvVars(nextProjectId, state.environment);
        await loadLatestBuild(nextProjectId, state.environment);
        connectSocket(nextProjectId);
      } catch (err) {
        showError(err);
      } finally {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        setState({ deletingProject: false });
      }
    });

    this.querySelector('#renameProject')?.addEventListener('click', async () => {
      const project = state.projects.find((p) => p.id === state.projectId);
      if (!project) return;
      const name = this.querySelector('#projectNameInput')?.value?.trim();
      if (!name) return setTaskStatus('Enter a project name', { autoHide: true });
      if (isProjectNameTaken(name, project.id)) return setTaskStatus('Project name already exists', { autoHide: true });
      try {
        await api(`/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
        await loadProjects();
      } catch (err) {
        if (String(err.message || '').toLowerCase().includes('already exists')) {
          setTaskStatus('Project name already exists. Please choose another.', { autoHide: true });
          return;
        }
        showError(err);
      }
    });

    this.querySelector('#updateProjectInterfaces')?.addEventListener('click', async () => {
      const project = state.projects.find((p) => p.id === state.projectId);
      if (!project) return;
      const interfaces = [];
      const webEnabled = this.querySelector('#projectInterfaceWeb')?.checked;
      const mobileEnabled = this.querySelector('#projectInterfaceMobile')?.checked;
      if (webEnabled) interfaces.push('web');
      if (mobileEnabled) interfaces.push('mobile');
      const mobileStackType = this.querySelector('input[name="projectMobileStack"]:checked')?.value || 'expo';
      try {
        await api(`/projects/${project.id}/interfaces`, {
          method: 'PUT',
          body: JSON.stringify({ interfaces, mobileStackType })
        });
        await loadProjects();
      } catch (err) {
        showError(err);
      }
    });

    this.querySelectorAll('input[name="env"]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const env = e.target.value;
        setState({ environment: env });
        storeEnv(state.user?.id, state.projectId, env);
        if (state.projectId) {
          loadEnvVars(state.projectId, env);
          loadLatestBuild(state.projectId, env);
        }
      });
    });

    this.querySelectorAll('.env-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const env = btn.getAttribute('data-env');
        if (!env) return;
        setState({
          environment: env,
          envEditing: { ...state.envEditing, [env]: false },
          envMessage: ''
        });
        storeEnv(state.user?.id, state.projectId, env);
        if (state.projectId) {
          loadEnvVars(state.projectId, env);
          loadLatestBuild(state.projectId, env);
        }
      });
    });

    this.querySelector('#stopEnvironment')?.addEventListener('click', async () => {
      if (!state.projectId) return;
      const env = state.environment;
      const ok = await showConfirm(`Stop the ${titleCase(env)} environment?`, { confirmText: 'Stop' });
      if (!ok) return;
      setTaskStatus('Stopping environment…', { autoHide: true });
      try {
        await api(`/projects/${state.projectId}/stop`, {
          method: 'POST',
          body: JSON.stringify({ environment: env })
        });
      } catch (err) {
        showError(err);
      }
    });

    this.querySelector('#nerdLevel')?.addEventListener('change', (e) => {
      const level = e.target.value;
      localStorage.setItem('vibes_nerd_level', level);
      if (level === 'beginner' && state.environment !== 'development') {
        setState({
          nerdLevel: level,
          environment: 'development',
          envEditing: { ...state.envEditing, development: false },
          envMessage: ''
        });
        storeEnv(state.user?.id, state.projectId, 'development');
        if (state.projectId) {
          loadEnvVars(state.projectId, 'development');
          loadLatestBuild(state.projectId, 'development');
        }
        return;
      }
      setState({ nerdLevel: level });
    });

    this.querySelector('#taskPrompt')?.addEventListener('input', (e) => {
      state.taskPromptDraft = e.target.value;
    });

    this.querySelector('#submitTask')?.addEventListener('click', async () => {
      const prompt = this.querySelector('#taskPrompt').value;
      if (!prompt) return setTaskStatus('Enter a task prompt', { autoHide: true });
      setTaskStatus('Reading Request', { persistent: true });
      try {
        const task = await api(`/projects/${state.projectId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({ prompt, environment: state.environment })
        });
        setState({ tasks: [task, ...state.tasks], taskPromptDraft: '', activeTaskId: task.id });
        this.querySelector('#taskPrompt').value = '';
      } catch (err) {
        showError(err);
      }
    });

    this.querySelector('#refreshBuildLog')?.addEventListener('click', async () => {
      if (!state.projectId) return;
      await loadLatestBuild(state.projectId, state.environment);
    });

    this.querySelector('#saveSession')?.addEventListener('click', () => {
      const canSaveSession = state.tasks.some((t) => t.environment === 'development' && !t.session_id);
      if (!canSaveSession) {
        setTaskStatus('Add at least one task before saving a session.', { autoHide: true });
        return;
      }
      this.querySelector('#saveModal').classList.add('open');
    });

    this.querySelector('#cancelSave')?.addEventListener('click', () => {
      this.querySelector('#saveModal').classList.remove('open');
    });

    this.querySelector('#confirmSave')?.addEventListener('click', async () => {
      const message = this.querySelector('#saveMessage').value;
      if (!message) return setTaskStatus('Enter a message', { autoHide: true });
      try {
        const session = await api(`/projects/${state.projectId}/sessions`, {
          method: 'POST',
          body: JSON.stringify({ message })
        });
        setState({ sessions: [session, ...state.sessions] });
        this.querySelector('#saveModal').classList.remove('open');
      } catch (err) {
        showError(err);
      }
    });

    const uploadRepoFile = async (file) => {
      if (!file) return;
      setState({ uploadBusy: true, repoMessage: 'Uploading...' });

      const attemptUpload = async (options = {}) => {
        const formData = new FormData();
        formData.append('file', file);
        if (options.confirmDropTasks) formData.append('confirmDropTasks', 'true');
        if (options.sessionMessage) formData.append('sessionMessage', options.sessionMessage);
        const res = await fetch(`${apiBaseUrl()}/projects/${state.projectId}/repo-upload`, {
          method: 'POST',
          headers: { ...authHeaders() },
          body: formData
        });
        if (res.ok) {
          await res.json();
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data?.requires) {
          const nextOptions = { ...options };
          if (data.requires.dropTasks) {
            const count = data.requires.dropTasks.count || (data.requires.dropTasks.ids || []).length || 0;
            setState({ repoMessage: 'Awaiting confirmation...' });
            const ok = await showConfirm(
              `This upload will remove ${count} task${count === 1 ? '' : 's'} from the top of the stack. Continue?`,
              { confirmText: 'Remove Tasks' }
            );
            if (!ok) throw new Error('Upload cancelled');
            nextOptions.confirmDropTasks = true;
          }
          if (data.requires.sessionMessage) {
            setState({ repoMessage: 'Session message required...' });
            const message = await showPrompt(
              'New commits were found on main. Add a saved session message to continue.',
              { placeholder: 'Session summary', confirmText: 'Save' }
            );
            if (!message || !message.trim()) throw new Error('Upload cancelled');
            nextOptions.sessionMessage = message.trim();
          }
          return attemptUpload(nextOptions);
        }
        throw new Error(data.error || 'Upload failed');
      };

      try {
        await attemptUpload();
        setState({ repoMessage: 'Upload complete' });
      } catch (err) {
        setState({ repoMessage: err.message || 'Upload failed' });
      } finally {
        setState({ uploadBusy: false });
      }
    };

    this.querySelector('#uploadRepo')?.addEventListener('click', () => {
      const input = this.querySelector('#repoFile');
      const file = input.files[0];
      if (!file) {
        input.click();
        return;
      }
      uploadRepoFile(file);
    });

    this.querySelector('#repoFile')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) uploadRepoFile(file);
    });

    this.querySelector('#downloadRepo')?.addEventListener('click', () => {
      const url = `${apiBaseUrl()}/projects/${state.projectId}/repo-download`;
      setState({ downloadBusy: true, repoMessage: 'Preparing download...' });
      fetch(url, { headers: { ...authHeaders() } })
        .then((res) => {
          if (!res.ok) return res.json().then((d) => Promise.reject(new Error(d.error || 'Download failed')));
          return res.blob();
        })
        .then((blob) => {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `${state.projects.find((p) => p.id === state.projectId)?.name || 'project'}.tar.gz`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setState({ repoMessage: 'Download ready' });
        })
        .catch((err) => setState({ repoMessage: err.message }))
        .finally(() => setState({ downloadBusy: false }));
    });

    const deployWebhookInput = this.querySelector('#deployWebhookUrl');
    const persistDeployWebhook = async (nextUrl) => {
      if (!state.projectId) {
        setState({ deployWebhookMessage: 'Select a project first.' });
        return;
      }
      setState({ deployWebhookBusy: true, deployWebhookMessage: 'Saving...' });
      try {
        const data = await api(`/projects/${state.projectId}/webhook`, {
          method: 'PUT',
          body: JSON.stringify({ url: nextUrl })
        });
        setState({
          deployWebhookUrl: data?.url || '',
          deployWebhookMessage: nextUrl ? 'Saved' : 'Cleared'
        });
      } catch (err) {
        setState({ deployWebhookMessage: err.message || 'Save failed.' });
      } finally {
        setState({ deployWebhookBusy: false });
      }
    };

    deployWebhookInput?.addEventListener('input', (event) => {
      state.deployWebhookUrl = event.target.value;
    });

    this.querySelector('#saveDeployWebhook')?.addEventListener('click', async () => {
      const raw = deployWebhookInput?.value || '';
      const nextUrl = raw.trim();
      if (nextUrl && !/^https?:\/\//i.test(nextUrl)) {
        setState({ deployWebhookMessage: 'URL must start with http:// or https://' });
        return;
      }
      await persistDeployWebhook(nextUrl);
    });

    this.querySelector('#clearDeployWebhook')?.addEventListener('click', async () => {
      if (deployWebhookInput) deployWebhookInput.value = '';
      state.deployWebhookUrl = '';
      await persistDeployWebhook('');
    });

    this.querySelector('#saveEnv')?.addEventListener('click', () => {
      const raw = this.querySelector('#envVars').value || '';
      const envVars = {};
      raw.split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
        const idx = line.indexOf('=');
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          envVars[key] = value;
        }
      });
      setState({ envBusy: true, envMessage: 'Saving...' });
      api(`/projects/${state.projectId}/env/${state.environment}`, {
        method: 'PUT',
        body: JSON.stringify({ envVars })
      })
        .then(() => {
          state.envVarsMap[state.environment] = raw;
          setState({
            envVarsMap: { ...state.envVarsMap },
            envMessage: 'Saved',
            envEditing: { ...state.envEditing, [state.environment]: false }
          });
        })
        .catch((err) => setState({ envMessage: err.message }))
        .finally(() => setState({ envBusy: false }));
    });

    const runLocalCommand = async (command, { killExisting = false, env = null, cwd = '' } = {}) => {
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) {
        setState({ localRunNotice: 'Desktop bridge not available.' });
        return '';
      }
      setState({ localRunBusy: true });
      updateLocalRunLog(`Running: ${command}\n`);
      try {
        const output = await window.__TAURI__.core.invoke('run_local_command', { command, cwd, killExisting, env });
        if (output) updateLocalRunLog(output, { append: true });
        return output || '';
      } catch (err) {
        updateLocalRunLog(`${err?.message || err}`, { append: true });
        return '';
      } finally {
        setState({ localRunBusy: false });
      }
    };

    const syncMobileEnv = async (platform = 'ios', cwd = '') => {
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return '';
      const apiUrl = await mobileApiUrlForProject(platform);
      if (!apiUrl || !state.projectId) return '';
      if (!cwd) return '';
      try {
        const output = await window.__TAURI__.core.invoke('write_mobile_env', { apiUrl, cwd });
        return output || '';
      } catch (err) {
        setState({ localRunNotice: `Mobile env update failed: ${err?.message || err}` });
        return '';
      }
    };

    const loadAndroidSetupStatus = async () => {
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return;
      setState({ androidSetupBusy: true, androidSetupMessage: '' });
      try {
        const status = await window.__TAURI__.core.invoke('android_setup_status');
        const nextStep = nextAndroidSetupStep(status);
        setState({ androidSetupStatus: status, androidSetupStep: nextStep });
      } catch (err) {
        setState({ androidSetupMessage: err?.message || String(err) });
      } finally {
        setState({ androidSetupBusy: false });
      }
    };

    const loadIosSetupStatus = async () => {
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return;
      setState({ iosSetupBusy: true, iosSetupMessage: '' });
      try {
        const status = await window.__TAURI__.core.invoke('ios_setup_status');
        const nextStep = nextIosSetupStep(status);
        setState({ iosSetupStatus: status, iosSetupStep: nextStep });
      } catch (err) {
        setState({ iosSetupMessage: err?.message || String(err) });
      } finally {
        setState({ iosSetupBusy: false });
      }
    };

    this.querySelector('#localRunIos')?.addEventListener('click', async () => {
      if (state.localRunActive && state.localRunPlatform === 'ios') {
        await stopLocalRunProcess();
        return;
      }
      if (state.localRunActive && state.localRunPlatform === 'android') {
        await stopLocalRunProcess();
      }
      setState({ localRunNotice: '' });
      if (!isIosSetupComplete(state.iosSetupStatus)) {
        setState({ iosSetupOpen: true, iosSetupStep: nextIosSetupStep(state.iosSetupStatus), iosSetupMessage: '' });
        loadIosSetupStatus();
        return;
      }
      const command = state.desktopSettings?.iosCommand || 'npx expo run:ios';
      stopLocalRunTail();
      setState({
        localRunActive: true,
        localRunPlatform: 'ios',
        localRunWaiting: true,
        localRunWaitMessage: 'Waiting for iOS Simulator and Metro…'
      });
      const cwd = await ensureDesktopRepo(state.projectId);
      if (!cwd) return;
      const output = await syncMobileEnv('ios', cwd);
      if (output) setState({ localRunLog: `${state.localRunLog}${output}` });
      const runOutput = await runLocalCommand(command, { cwd });
      const logPath = extractLogPath(runOutput || '');
      if (logPath) {
        startLocalRunTail(logPath, `Running: ${command}`);
      }
      await waitForRuntime('ios');
    });

    this.querySelector('#localRunAndroid')?.addEventListener('click', async () => {
      if (state.localRunActive && state.localRunPlatform === 'android') {
        await stopLocalRunProcess();
        return;
      }
      if (state.localRunActive && state.localRunPlatform === 'ios') {
        await stopLocalRunProcess();
      }
      setState({ localRunNotice: '' });
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) {
        setState({ localRunNotice: 'Desktop bridge not available.' });
        return;
      }
      let status = state.androidSetupStatus;
      try {
        status = await window.__TAURI__.core.invoke('android_setup_status');
        setState({ androidSetupStatus: status, androidSetupStep: nextAndroidSetupStep(status) });
      } catch (err) {
        setState({ localRunNotice: err?.message || String(err) });
        return;
      }
      if (!isAndroidSetupComplete(status)) {
        setState({ androidSetupOpen: true, androidSetupStep: nextAndroidSetupStep(status), androidSetupMessage: '' });
        return;
      }
      if (!hasAndroidDevice(status)) {
        setState({ localRunNotice: 'No Android emulator detected. Open Android Studio → Tools → Device Manager → ▶︎ to start one.' });
        return;
      }
      const command = state.desktopSettings?.androidCommand || 'npx expo run:android';
      stopLocalRunTail();
      setState({
        localRunActive: true,
        localRunPlatform: 'android',
        localRunWaiting: true,
        localRunWaitMessage: 'Waiting for Android Emulator and Metro…'
      });
      const cwd = await ensureDesktopRepo(state.projectId);
      if (!cwd) return;
      const output = await syncMobileEnv('android', cwd);
      if (output) setState({ localRunLog: `${state.localRunLog}${output}` });
      const runOutput = await runLocalCommand(command, { cwd });
      const logPath = extractLogPath(runOutput || '');
      if (logPath) {
        startLocalRunTail(logPath, `Running: ${command}`);
      }
      await waitForRuntime('android');
    });

    // stop button handled via per-platform toggle

    this.querySelector('#androidWizardInstall')?.addEventListener('click', () => {
      window.open('https://developer.android.com/studio', '_blank', 'noopener');
    });

    this.querySelector('#androidWizardConfigure')?.addEventListener('click', async () => {
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return;
      setState({ androidSetupBusy: true, androidSetupMessage: '' });
      try {
        setState({
          androidSetupMessage: `Open Android Studio manually, then Settings (${settingsShortcutLabel()}) → Languages & Frameworks → Android SDK → SDK Tools.`
        });
        const status = await window.__TAURI__.core.invoke('android_setup_status');
        const nextStep = nextAndroidSetupStep(status);
        setState({ androidSetupStatus: status, androidSetupStep: nextStep });
        if (status.sdkmanager && status.emulator && status.adb) {
          const output = await window.__TAURI__.core.invoke('android_setup_apply');
          const refreshed = await window.__TAURI__.core.invoke('android_setup_status');
          setState({ androidSetupStatus: refreshed, androidSetupStep: nextAndroidSetupStep(refreshed) });
          if (output) {
            setState({ androidSetupMessage: 'SDK configured. Continue to the next step.' });
          }
        } else {
          setState({ androidSetupMessage: 'SDK tools not detected yet. Install Command-line Tools, Emulator, and Platform-Tools, then click again.' });
        }
      } catch (err) {
        setState({ androidSetupMessage: err?.message || String(err) });
      } finally {
        setState({ androidSetupBusy: false });
      }
    });

    this.querySelector('#androidWizardPath')?.addEventListener('click', async () => {
      if (!DESKTOP_BRIDGE || !window.__TAURI__?.core?.invoke) return;
      setState({ androidSetupBusy: true, androidSetupMessage: '' });
      try {
        const output = await window.__TAURI__.core.invoke('android_setup_add_path');
        if (output) {
          setState({ androidSetupMessage: output });
        }
        await loadAndroidSetupStatus();
      } catch (err) {
        setState({ androidSetupMessage: err?.message || String(err) });
      } finally {
        setState({ androidSetupBusy: false });
      }
    });

    this.querySelector('#androidWizardBack')?.addEventListener('click', () => {
      const next = Math.max(1, (state.androidSetupStep || 1) - 1);
      setState({ androidSetupStep: next, androidSetupMessage: '' });
    });

    this.querySelector('#androidWizardNext')?.addEventListener('click', async () => {
      if (state.androidSetupBusy) return;
      await loadAndroidSetupStatus();
      const status = state.androidSetupStatus || {};
      const step = state.androidSetupStep || 1;
      let missing = [];
      if (step === 1 && !status.studio_installed) missing.push('Android Studio');
      if (step === 2) {
        if (!status.sdkmanager) missing.push('Command-line Tools');
        if (!status.emulator) missing.push('Android Emulator');
        if (!status.adb) missing.push('Platform-Tools');
        if (!status.adb_in_path) missing.push('adb in PATH');
        if (!status.emulator_in_path) missing.push('emulator in PATH');
        if (!status.java_ok) missing.push('Java (JDK)');
      }
      if (step === 3 && (!Array.isArray(status.avds) || status.avds.length === 0)) {
        missing.push('Emulator (AVD)');
      }
      if (step === 5 && !hasAndroidDevice(status)) {
        setState({ androidSetupMessage: 'No emulator detected. Open Android Studio → Tools → Device Manager → Start an emulator.' });
        return;
      }
      if (missing.length) {
        setState({ androidSetupMessage: `Missing: ${missing.join(', ')}.` });
        return;
      }
      if (step === 4) {
        const nextDesktopSettings = {
          ...state.desktopSettings,
          androidEmulatorWindowConfigured: true
        };
        saveDesktopSettings(state.user?.id, nextDesktopSettings);
        setState({ desktopSettings: nextDesktopSettings });
      }
      if (step >= 5) {
        setState({ androidSetupOpen: false, androidSetupMessage: '' });
        return;
      }
      const next = Math.min(5, step + 1);
      setState({ androidSetupStep: next, androidSetupMessage: '' });
    });

    this.querySelector('#iosWizardInstall')?.addEventListener('click', () => {
      window.open('https://apps.apple.com/app/xcode/id497799835', '_blank', 'noopener');
    });

    this.querySelector('#iosWizardBack')?.addEventListener('click', () => {
      const next = Math.max(1, (state.iosSetupStep || 1) - 1);
      setState({ iosSetupStep: next, iosSetupMessage: '' });
    });

    this.querySelector('#iosWizardNext')?.addEventListener('click', async () => {
      await loadIosSetupStatus();
      const status = state.iosSetupStatus || {};
      const step = state.iosSetupStep || 1;
      if (status.supported === false) {
        setState({ iosSetupMessage: 'iOS Simulator is only available on macOS.' });
        return;
      }
      let missing = [];
      if (step === 1 && !status.xcode_installed) missing.push('Xcode');
      if (step === 2 && !status.xcode_license) missing.push('Xcode license');
      if (step === 3 && (!Array.isArray(status.simulators) || status.simulators.length === 0)) {
        missing.push('Simulator device');
      }
      if (missing.length) {
        setState({ iosSetupMessage: `Missing: ${missing.join(', ')}.` });
        return;
      }
      const next = Math.min(4, step + 1);
      setState({ iosSetupStep: next, iosSetupMessage: '' });
    });

    this.querySelector('#iosSetupClose')?.addEventListener('click', () => {
      setState({ iosSetupOpen: false, iosSetupMessage: '' });
    });

    this.querySelector('#iosSetupModal')?.addEventListener('click', (event) => {
      if (event.target?.id === 'iosSetupModal') {
        setState({ iosSetupOpen: false });
      }
    });

    this.querySelector('#androidSetupClose')?.addEventListener('click', () => {
      setState({ androidSetupOpen: false, androidSetupMessage: '' });
    });

    this.querySelector('#androidSetupModal')?.addEventListener('click', (event) => {
      if (event.target?.id === 'androidSetupModal') {
        setState({ androidSetupOpen: false });
      }
    });

    if (DESKTOP_BRIDGE && !state.androidSetupStatus && !state.androidSetupBusy) {
      loadAndroidSetupStatus();
    }
    if (DESKTOP_BRIDGE && !state.iosSetupStatus && !state.iosSetupBusy) {
      loadIosSetupStatus();
    }

    this.querySelector('#editEnv')?.addEventListener('click', () => {
      setState({ envEditing: { ...state.envEditing, [state.environment]: true }, envMessage: '' });
    });

    this.querySelector('#cancelEnv')?.addEventListener('click', () => {
      setState({ envEditing: { ...state.envEditing, [state.environment]: false }, envMessage: '' });
    });

    this.querySelector('#emptyDb')?.addEventListener('click', async () => {
      const ok = await showConfirm(`Empty database for ${state.environment}?`, { confirmText: 'Empty' });
      if (!ok) return;
      api(`/projects/${state.projectId}/env/${state.environment}/empty-db`, { method: 'POST' })
        .then(() => setState({ envMessage: 'Empty DB started' }))
        .catch((err) => setState({ envMessage: err.message }));
    });

    this.querySelectorAll('.delete-latest-task').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await showConfirm('Delete latest task? This is permanent.', { confirmText: 'Delete' });
        if (!ok) return;
        try {
          await api(`/projects/${state.projectId}/tasks/latest`, { method: 'DELETE' });
        } catch (err) {
          showError(err);
        }
      });
    });

    this.querySelectorAll('.deploy-button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const commitHash = btn.getAttribute('data-commit');
        if (!commitHash) return setTaskStatus('No commit hash available', { autoHide: true });
        state.pendingDeployCommit[state.environment] = commitHash;
        state.buildStatus[state.environment] = 'building';
        state.progressVisibleUntil[state.environment] = 0;
        setState({
          pendingDeployCommit: { ...state.pendingDeployCommit },
          buildStatus: { ...state.buildStatus },
          progressVisibleUntil: { ...state.progressVisibleUntil }
        });
        try {
          await api(`/projects/${state.projectId}/deploy`, {
            method: 'POST',
            body: JSON.stringify({ commitHash, environment: state.environment })
          });
        } catch (err) {
          showError(err);
        }
      });
    });

    this.querySelectorAll('.logs-button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const current = state.taskLogs[id] || { open: false };
        const nextOpen = !current.open;
        state.taskLogs[id] = { ...current, open: nextOpen };
        setState({ taskLogs: { ...state.taskLogs } });
        if (nextOpen) {
          await fetchRuntimeLogs(id);
        }
      });
    });

    this.querySelectorAll('.refresh-logs').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await fetchRuntimeLogs(id);
      });
    });

    this.querySelectorAll('.fetch-logs').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await fetchRuntimeLogs(id, 600);
      });
    });

    this.querySelectorAll('.copy-logs').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!id) return;
        const log = state.taskLogs[id]?.serverLog || '';
        if (!log) return setTaskStatus('No logs to copy yet.', { autoHide: true });
        try {
          await navigator.clipboard.writeText(log);
          setTaskStatus('Copied application logs', { autoHide: true });
        } catch {
          const temp = document.createElement('textarea');
          temp.value = log;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          temp.remove();
          setTaskStatus('Copied application logs', { autoHide: true });
        }
      });
    });

    this.querySelectorAll('.copy-task').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const block = btn.closest('.detail-block');
        const pre = block?.querySelector('pre');
        const text = pre?.textContent || '';
        if (!text) return setTaskStatus('Nothing to copy', { autoHide: true });
        try {
          await navigator.clipboard.writeText(text);
          setTaskStatus('Copied', { autoHide: true });
        } catch {
          const temp = document.createElement('textarea');
          temp.value = text;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          temp.remove();
          setTaskStatus('Copied', { autoHide: true });
        }
      });
    });

    this.querySelector('#toggleFailedBuildLog')?.addEventListener('click', async () => {
      const env = state.environment;
      if (state.failedBuildLogVisible[env]) {
        state.failedBuildLogVisible[env] = false;
        setState({ failedBuildLogVisible: { ...state.failedBuildLogVisible } });
        return;
      }
      await loadFailedBuildLog(state.projectId, env, { force: true });
    });

    this.querySelector('#openFailedBuildLog')?.addEventListener('click', async () => {
      const env = state.environment;
      if (state.failedBuildLogVisible[env]) return;
      await loadFailedBuildLog(state.projectId, env, { force: true });
    });

    this.querySelector('#refreshFailedBuildLog')?.addEventListener('click', async () => {
      const env = state.environment;
      await loadFailedBuildLog(state.projectId, env, { force: true });
    });

    this.querySelector('#expandFailedBuildLog')?.addEventListener('click', async () => {
      const env = state.environment;
      await loadFailedBuildLog(state.projectId, env, { force: true, lines: 2000 });
    });
  }
}

customElements.define('app-shell', AppShell);

if (state.token) {
  if (!state.user) {
    const tokenUser = userFromToken(state.token);
    if (tokenUser) setState({ user: tokenUser, desktopSettings: loadDesktopSettings(tokenUser?.id) });
  }
  loadProjects();
}
