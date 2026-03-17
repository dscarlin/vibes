const API_URL = window.__API_URL__ || 'http://localhost:8000';
const DOMAIN = window.__DOMAIN__ || 'localhost:8000';
const UPGRADE_URL = window.__UPGRADE_URL__ || '';
const DESKTOP_BRIDGE = Boolean(window.__TAURI__?.core);
const RUNTIME_LIMITS_FALLBACK = {
  starter: { development: 60 },
  builder: { development: 100, testing: 60 },
  business: { development: 200, testing: 100, production: 750 },
  agency: { development: 500, testing: 250, production: 750 }
};
const DATABASE_PAGE_SIZE_OPTIONS = [5, 10, 25, 50, 100];
const DEFAULT_DATABASE_PAGE_SIZE = DATABASE_PAGE_SIZE_OPTIONS[0];

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
  demoOpenAiKeyDraft: null,
  deploymentPolicy: {
    verifiedOnly: false
  },
  settingsBusy: false,
  settingsMessage: '',
  confirmOpen: false,
  confirmTitle: 'Confirm',
  confirmMessage: '',
  confirmConfirmText: 'Confirm',
  confirmCancelText: 'Cancel',
  confirmAltText: '',
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
  authModalOpen: false,
  authModalMode: 'register',
  authErrorMessage: '',
  authErrorCode: '',
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
  appLogsVisible: false,
  appLogsByEnv: {
    development: '',
    testing: '',
    production: ''
  },
  appLogSnapshotByEnv: {
    development: '',
    testing: '',
    production: ''
  },
  appLogLoading: {
    development: false,
    testing: false,
    production: false
  },
  appLogError: {
    development: '',
    testing: '',
    production: ''
  },
  appLogFrozenByEnv: {
    development: false,
    testing: false,
    production: false
  },
  taskDetails: {},
  sessionDetails: {},
  taskPromptDraft: '',
  taskSubmissionPending: null,
  taskProcessingHydration: {
    projectId: null,
    tasksLoaded: false,
    buildLoaded: false
  },
  toasts: [],
  authNotice: '',
  createProjectNotice: '',
  projectNotice: '',
  runtimeUsage: { month: '', plan: '', usage: {} },
  runtimeUsageLoading: false,
  runtimeUsageError: '',
  runtimeQuotaNotice: {},
  database: {
    catalogs: {
      development: null,
      testing: null,
      production: null
    },
    catalogLoading: blankEnvMap(false),
    catalogError: blankEnvMap(''),
    selected: {
      development: { schema: '', object: '', type: '', tab: 'browse' },
      testing: { schema: '', object: '', type: '', tab: 'browse' },
      production: { schema: '', object: '', type: '', tab: 'browse' }
    },
    objectDetails: {
      development: null,
      testing: null,
      production: null
    },
    objectLoading: blankEnvMap(false),
    objectError: blankEnvMap(''),
    rows: {
      development: null,
      testing: null,
      production: null
    },
    rowLoading: blankEnvMap(false),
    rowError: blankEnvMap(''),
    controls: blankDbControls(),
    sqlDraft: blankEnvMap(''),
    queryResult: {
      development: null,
      testing: null,
      production: null
    },
    queryLoading: blankEnvMap(false),
    queryError: blankEnvMap(''),
    history: {
      development: [],
      testing: [],
      production: []
    },
    historyLoading: blankEnvMap(false),
    historyError: blankEnvMap(''),
    notice: ''
  }
};

let socketClient = null;
let socketProjectId = null;
let runtimeUsageTimer = null;
let headerProgressTimer = null;
let confirmResolver = null;
let promptResolver = null;
let localRunTailTimer = null;
let localRunWaitTimer = null;
let buildLogPoller = null;
let appLogPoller = null;
let appLogTypewriter = null;
let appLogLineQueue = [];
let appLogQueueEnv = '';
let appLogScrollAnchor = null;
let toastCounter = 0;
const toastTimers = new Map();
const recentToastKeys = new Map();
const APP_LOG_POLL_INTERVAL_MS = 2000;
const APP_LOG_FETCH_LINES = 2000;
const APP_LOG_TYPE_INTERVAL_MS = 40;

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

function databaseSqlStorageKey(userId, projectId, environment) {
  if (!userId || !projectId || !environment) return null;
  return `vibes_db_sql_${userId}_${projectId}_${environment}`;
}

function loadStoredDatabaseSql(userId, projectId, environment) {
  const key = databaseSqlStorageKey(userId, projectId, environment);
  if (!key) return '';
  return localStorage.getItem(key) || '';
}

function storeDatabaseSql(userId, projectId, environment, sql) {
  const key = databaseSqlStorageKey(userId, projectId, environment);
  if (!key) return;
  localStorage.setItem(key, sql || '');
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

function currentProjectState() {
  return state.projects.find((p) => p.id === state.projectId) || null;
}

function projectEnvironmentState(projectOrId, environment) {
  const project =
    typeof projectOrId === 'string'
      ? state.projects.find((p) => p.id === projectOrId) || null
      : projectOrId || null;
  return project?.environments?.[environment] || null;
}

function isDevelopmentPreviewActive(envState = projectEnvironmentState(state.projectId, 'development')) {
  return Boolean(
    envState &&
    envState.preview_mode === 'workspace' &&
    envState.workspace_state === 'ready' &&
    envState.build_status === 'live'
  );
}

function isBackgroundDevelopmentVerifyStatus(status, envState = projectEnvironmentState(state.projectId, 'development')) {
  if (!isDevelopmentPreviewActive(envState)) return false;
  return ['building', 'failed', 'cancelled', 'live'].includes(String(status || '').toLowerCase());
}

function normalizeDevelopmentModeValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['workspace', 'preview'].includes(normalized)) return 'workspace';
  return 'verified';
}

function developmentModeText(mode) {
  return normalizeDevelopmentModeValue(mode) === 'workspace' ? 'Preview Mode' : 'Full Build Mode';
}

function developmentSelectedMode(project) {
  const envState = projectEnvironmentState(project, 'development');
  return normalizeDevelopmentModeValue(envState?.selected_mode || envState?.preview_mode || 'verified');
}

function developmentLiveMode(project) {
  const envState = projectEnvironmentState(project, 'development');
  return normalizeDevelopmentModeValue(envState?.preview_mode || envState?.selected_mode || 'verified');
}

function isDevelopmentAwake(envState = projectEnvironmentState(state.projectId, 'development')) {
  if (!envState) return false;
  const buildStatus = String(envState.build_status || '').toLowerCase();
  const workspaceState = String(envState.workspace_state || '').toLowerCase();
  return buildStatus !== 'offline' || (workspaceState && workspaceState !== 'sleeping');
}

function isDevelopmentOpenable(envState = projectEnvironmentState(state.projectId, 'development')) {
  if (!envState) return false;
  const buildStatus = String(envState.build_status || '').toLowerCase();
  const liveMode = normalizeDevelopmentModeValue(envState.preview_mode || envState.selected_mode || 'verified');
  if (buildStatus !== 'live') return false;
  if (liveMode === 'verified') return true;
  return String(envState.workspace_state || '').toLowerCase() === 'ready';
}

function isDevelopmentTransitioning(envState = projectEnvironmentState(state.projectId, 'development')) {
  if (!envState) return false;
  const buildStatus = String(envState.build_status || '').toLowerCase();
  const workspaceState = String(envState.workspace_state || '').toLowerCase();
  return buildStatus === 'building' || buildStatus === 'canceling' || workspaceState === 'starting';
}

function developmentPrimaryStatus(project, status) {
  const envState = projectEnvironmentState(project, 'development');
  if (envState?.workspace_state === 'starting') return 'preview_starting';
  if (envState?.workspace_state === 'failed' && envState?.preview_mode === 'workspace') return 'preview_failed';
  if (envState?.workspace_state === 'sleeping' || status === 'offline') return 'preview_sleeping';
  if (envState?.preview_mode === 'workspace' && status === 'live') return 'preview_live';
  if (envState?.preview_mode === 'verified' && status === 'live') return 'verified_live';
  return status;
}

function developmentModeLabel(project, source = 'selected') {
  if (state.deploymentPolicy?.verifiedOnly) return 'Full Build Mode';
  const mode = source === 'live' ? developmentLiveMode(project) : developmentSelectedMode(project);
  return developmentModeText(mode);
}

function developmentVerificationStatus(project) {
  const envState = projectEnvironmentState(project, 'development');
  if (!envState) return '';
  const buildStatus = String(envState.build_status || '').toLowerCase();
  const workspaceState = String(envState.workspace_state || '').toLowerCase();
  if (workspaceState === 'failed') return 'Failed';
  if (!isDevelopmentAwake(envState)) return 'Sleeping';
  if (buildStatus === 'canceling') return 'Stopping';
  if (buildStatus === 'building' && developmentSelectedMode(project) === 'verified') return 'Building';
  if (isDevelopmentTransitioning(envState)) return 'Starting';
  if (buildStatus === 'live') return 'Live';
  return '';
}

function developmentSecondaryBadgeClass(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return 'offline';
  if (normalized.includes('failed')) return 'failed';
  if (normalized.includes('build') || normalized.includes('start') || normalized.includes('stop')) return 'building';
  if (normalized.includes('live')) return 'live';
  if (normalized.includes('sleep')) return 'offline';
  return 'offline';
}

function developmentVerificationStatusForCommit(commitHash, latestBuild = state.latestBuild.development) {
  if (!commitHash || !latestBuild?.ref_commit || latestBuild.ref_commit !== commitHash) return '';
  const status = String(latestBuild.status || '').toLowerCase();
  if (status === 'building') return 'verifying';
  if (status === 'live') return 'verified';
  if (status === 'failed') return 'verify failed';
  return '';
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
    pushToast({ message: `Repo sync failed: ${err?.message || err}`, tone: 'error', dedupeKey: `repo-sync:${projectId}` });
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
    pushToast({ message: `Repo refresh failed: ${err?.message || err}`, tone: 'error', dedupeKey: `repo-refresh:${projectId}` });
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

function captureAppLogScrollAnchor() {
  const pre = document.querySelector('pre[data-app-log-stream]');
  if (!pre) {
    appLogScrollAnchor = null;
    return;
  }
  const distanceFromBottom = Math.max(0, pre.scrollHeight - pre.clientHeight - pre.scrollTop);
  appLogScrollAnchor = { distanceFromBottom };
}

function restoreAppLogScrollAnchor() {
  const pre = document.querySelector('pre[data-app-log-stream]');
  if (!pre || !appLogScrollAnchor) return;
  pre.scrollTop = Math.max(0, pre.scrollHeight - pre.clientHeight - appLogScrollAnchor.distanceFromBottom);
}

function setState(partial) {
  captureAppLogScrollAnchor();
  Object.assign(state, partial);
  document.querySelector('app-shell')?.render();
  restoreAppLogScrollAnchor();
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

function clearExpiredToastKeys() {
  const now = Date.now();
  for (const [key, expiresAt] of recentToastKeys.entries()) {
    if (expiresAt <= now) recentToastKeys.delete(key);
  }
}

function dismissToast(id) {
  const timer = toastTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
  if (!state.toasts.some((toast) => toast.id === id)) return;
  setState({ toasts: state.toasts.filter((toast) => toast.id !== id) });
}

function clearAllToasts() {
  for (const timer of toastTimers.values()) {
    clearTimeout(timer);
  }
  toastTimers.clear();
  setState({ toasts: [] });
}

function pushToast({ message, tone = 'info', durationMs = 3000, dedupeKey = '', html = '', allowHtml = false } = {}) {
  const text = String(message || '').trim();
  const trustedHtml = allowHtml ? String(html || text || '').trim() : '';
  if (!text && !trustedHtml) return null;
  clearExpiredToastKeys();
  if (dedupeKey) {
    const active = state.toasts.some((toast) => toast.dedupeKey === dedupeKey);
    const recent = recentToastKeys.has(dedupeKey);
    if (active || recent) return null;
  }
  const id = `toast-${Date.now()}-${++toastCounter}`;
  const createdAt = Date.now();
  const expiresAt = createdAt + Math.max(500, Number(durationMs) || 3000);
  const nextToast = {
    id,
    tone,
    message: text,
    html: trustedHtml,
    allowHtml: Boolean(allowHtml && trustedHtml),
    createdAt,
    expiresAt,
    dedupeKey
  };
  const nextToasts = [...state.toasts, nextToast].slice(-3);
  const dropped = state.toasts.filter((toast) => !nextToasts.some((item) => item.id === toast.id));
  dropped.forEach((toast) => {
    const timer = toastTimers.get(toast.id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.delete(toast.id);
    }
  });
  setState({ toasts: nextToasts });
  if (dedupeKey) recentToastKeys.set(dedupeKey, expiresAt);
  const timer = setTimeout(() => dismissToast(id), expiresAt - Date.now());
  toastTimers.set(id, timer);
  return id;
}

function setTaskProcessingHydration(projectId, patch = {}) {
  const nextProjectId = projectId ?? state.projectId ?? null;
  const base =
    state.taskProcessingHydration?.projectId === nextProjectId
      ? state.taskProcessingHydration
      : { projectId: nextProjectId, tasksLoaded: false, buildLoaded: false };
  setState({
    taskProcessingHydration: {
      ...base,
      ...patch,
      projectId: nextProjectId
    }
  });
}

function resetTaskProcessingState(projectId = state.projectId) {
  setState({
    taskSubmissionPending: null,
    taskProcessingHydration: {
      projectId: projectId ?? null,
      tasksLoaded: false,
      buildLoaded: false
    }
  });
}

function currentDevelopmentTask(tasks = state.tasks) {
  return (Array.isArray(tasks) ? tasks : []).find((task) => String(task?.environment || 'development').toLowerCase() === 'development') || null;
}

function taskById(taskId, tasks = state.tasks) {
  if (!taskId) return null;
  return (Array.isArray(tasks) ? tasks : []).find((task) => String(task?.id) === String(taskId)) || null;
}

function taskBuildMatchesProcessingFlow(
  task,
  envState = projectEnvironmentState(state.projectId, 'development'),
  latestBuild = state.latestBuild.development
) {
  if (!task?.commit_hash || !envState || !latestBuild?.ref_commit) return false;
  const taskId = String(task.id || '');
  const commitHash = String(task.commit_hash || '');
  const selectedTaskMatches = String(envState.selected_task_id || '') === taskId;
  const liveTaskMatches = String(envState.live_task_id || '') === taskId;
  const selectedCommitMatches = String(envState.selected_commit_sha || '') === commitHash;
  const liveCommitMatches = String(envState.live_commit_sha || '') === commitHash;
  return latestBuild.ref_commit === commitHash && (selectedTaskMatches || liveTaskMatches || selectedCommitMatches || liveCommitMatches);
}

function currentDevelopmentTaskForBuild(
  envState = projectEnvironmentState(state.projectId, 'development'),
  latestBuild = state.latestBuild.development
) {
  const byLiveTask = taskById(envState?.live_task_id);
  if (byLiveTask && taskBuildMatchesProcessingFlow(byLiveTask, envState, latestBuild)) return byLiveTask;
  const bySelectedTask = taskById(envState?.selected_task_id);
  if (bySelectedTask && taskBuildMatchesProcessingFlow(bySelectedTask, envState, latestBuild)) return bySelectedTask;
  const latestTask = currentDevelopmentTask();
  if (latestTask && taskBuildMatchesProcessingFlow(latestTask, envState, latestBuild)) return latestTask;
  return null;
}

function deriveTaskProcessingView() {
  if (state.environment !== 'development' || !state.projectId) return null;
  const pending = state.taskSubmissionPending;
  if (pending?.projectId === state.projectId && pending.environment === 'development') {
    return { state: 'submission_pending', message: 'Reading Request', taskId: null };
  }
  const hydration = state.taskProcessingHydration || {};
  if (hydration.projectId !== state.projectId || !hydration.tasksLoaded || !hydration.buildLoaded) {
    return null;
  }
  const task = currentDevelopmentTask();
  if (!task) return null;
  const status = String(task.status || '').toLowerCase();
  if (status === 'queued') {
    return { state: 'queued', message: 'Reading Request', taskId: task.id };
  }
  if (status === 'running') {
    return { state: 'running', message: 'Designing and implementing changes', taskId: task.id };
  }
  if (status !== 'completed') return null;
  const envState = projectEnvironmentState(state.projectId, 'development');
  const latestBuild = state.latestBuild.development;
  if (!envState) return null;
  const workspaceState = String(envState.workspace_state || '').toLowerCase();
  const buildStatus = String(envState.build_status || '').toLowerCase();
  const verifyStatus = String(latestBuild?.status || '').toLowerCase();
  const taskLinkedBuild = taskBuildMatchesProcessingFlow(task, envState, latestBuild);
  const followOnActive =
    workspaceState === 'starting' ||
    buildStatus === 'building' ||
    (taskLinkedBuild && verifyStatus === 'building');
  if (!followOnActive) return null;
  return { state: 'deploying_or_verifying', message: 'Deploying your update', taskId: task.id };
}

function setInlineNotice(field, message = '') {
  if (!field) return;
  setState({ [field]: message || '' });
}

function showError(err, { noticeField = '', tone = 'error', dedupeKey = '' } = {}) {
  const message = err?.message || String(err || '');
  const isPlanError = Boolean(err?.code && String(err.code).startsWith('plan_'));
  if (noticeField) {
    setInlineNotice(noticeField, message);
    return;
  }
  if (isPlanError && state.projectId) {
    setInlineNotice('projectNotice', message);
    return;
  }
  pushToast({ message, tone, dedupeKey });
}

function notifyTaskTerminalResult(task, status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (!task?.id || !['failed', 'cancelled'].includes(normalizedStatus)) return;
  pushToast({
    message: normalizedStatus === 'failed' ? 'Task failed before deployment completed' : 'Task cancelled',
    tone: normalizedStatus === 'failed' ? 'error' : 'warning',
    dedupeKey: `task-result:${task.id}:${normalizedStatus}`
  });
}

function notifyDevelopmentBuildTerminal(payload) {
  if (payload?.environment !== 'development') return;
  const status = String(payload.status || '').toLowerCase();
  if (!['live', 'failed', 'cancelled'].includes(status)) return;
  const envState = projectEnvironmentState(state.projectId, 'development');
  const latestBuild = {
    ...(state.latestBuild.development || {}),
    ...(payload?.refCommit ? { ref_commit: payload.refCommit } : {}),
    ...(payload?.status ? { status: payload.status } : {})
  };
  const task = currentDevelopmentTaskForBuild(envState, latestBuild);
  if (!task?.id) return;
  const tone = status === 'live' ? 'success' : status === 'failed' ? 'error' : 'warning';
  const message =
    status === 'live'
      ? 'Your update is live'
      : status === 'failed'
        ? 'Deployment failed for the latest task'
        : 'Deployment cancelled for the latest task';
  pushToast({
    message,
    tone,
    dedupeKey: `build-result:${state.projectId}:development:${latestBuild.ref_commit || ''}:${status}`
  });
}

function showConfirmChoices(message, {
  title = 'Confirm',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  altText = ''
} = {}) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    setState({
      confirmOpen: true,
      confirmTitle: title,
      confirmMessage: message,
      confirmConfirmText: confirmText,
      confirmCancelText: cancelText,
      confirmAltText: altText
    });
  });
}

function showConfirm(message, { title = 'Confirm', confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
  return showConfirmChoices(message, { title, confirmText, cancelText }).then((choice) => choice === 'confirm');
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
  if(!value) return '0';
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  if (Math.abs(num - Math.round(num)) < 0.05) return String(Math.round(num));
  return num.toFixed(1).replace(/\.0$/, '');
}

function runtimeLimitHoursForCurrentEnv() {
  const usage = state.runtimeUsage?.usage?.[state.environment];
  if (usage?.limit_hours != null) return usage.limit_hours;
  const explicitLimit = state.user?.runtime_limits?.[state.environment];
  if (explicitLimit != null) return explicitLimit;
  const planKey = String(state.user?.plan || state.runtimeUsage?.plan || '').toLowerCase();
  return RUNTIME_LIMITS_FALLBACK[planKey]?.[state.environment] ?? null;
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

function formatAuthError(code) {
  if (code === 'auth_registration_closed') {
    return 'Sorry, customer registration is not yet open. We will let you know when it is and we hope to see you again soon!';
  }
  if (code === 'auth_email_required') {
    return 'Please enter your email address.';
  }
  if (code === 'auth_invalid_credentials') {
    return 'Invalid email or password.';
  }
  return 'Something went wrong. Please try again.';
}

function clearAuthError({ render = true } = {}) {
  if (!state.authErrorMessage && !state.authErrorCode) return;
  if (render) {
    setState({ authErrorMessage: '', authErrorCode: '' });
    return;
  }
  state.authErrorMessage = '';
  state.authErrorCode = '';
  document.querySelectorAll('.auth-panel-error').forEach((node) => node.remove());
}

function setAuthError(err) {
  const code = String(err?.code || err?.details?.error || '');
  setState({
    authErrorCode: code,
    authErrorMessage: formatAuthError(code)
  });
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
    const projectChanged = Boolean(state.projectId && projectId && state.projectId !== projectId);
    if (projectChanged) stopAppLogPolling();
    if (projectChanged || !projectId) resetTaskProcessingState(projectId);
    setState({
      projects,
      projectId,
      environment: storedEnv || state.environment,
      ...(projectChanged
        ? {
            database: createDatabaseState(),
            appLogsByEnv: blankEnvMap(''),
            appLogSnapshotByEnv: blankEnvMap(''),
            appLogLoading: blankEnvMap(false),
            appLogError: blankEnvMap(''),
            appLogFrozenByEnv: blankEnvMap(false)
          }
        : {})
    });
    await loadRuntimeUsage();
    if (!projectId) {
      stopAppLogPolling();
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
        appLogsVisible: false,
        appLogsByEnv: blankEnvMap(''),
        appLogSnapshotByEnv: blankEnvMap(''),
        appLogLoading: blankEnvMap(false),
        appLogError: blankEnvMap(''),
        appLogFrozenByEnv: blankEnvMap(false),
        environment: 'development',
        nerdLevel: 'beginner',
        createProjectNotice: '',
        database: createDatabaseState()
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
    setDatabaseState(resetDatabaseStateForProject());
    await loadDatabaseCatalog(projectId, state.environment);
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
    const nextUser = data?.plan && state.user ? { ...state.user, plan: data.plan } : state.user;
    setState({ runtimeUsage: data, runtimeUsageLoading: false, ...(nextUser ? { user: nextUser } : {}) });
  } catch (err) {
    setState({ runtimeUsageLoading: false, runtimeUsageError: err.message || 'Failed to load runtime usage.' });
  }
}

async function loadCurrentUser() {
  if (!state.token) return null;
  try {
    const data = await api('/auth/me', { timeoutMs: 15000 });
    if (data?.user) {
      setState({ user: data.user, desktopSettings: loadDesktopSettings(data.user?.id) });
      return data.user;
    }
  } catch (err) {
    if ((err?.message || '').toLowerCase().includes('unauthorized')) {
      localStorage.removeItem('vibes_token');
      setState({ token: '', user: null, desktopSettings: loadDesktopSettings(null) });
      return null;
    }
  }
  return null;
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

function updateBuildLogPanel(build) {
  if (!build) return;
  const logText = build.build_log || 'No build log available.';
  const pre = document.querySelector('.build-log pre[data-build-log]');
  if (!pre) return;
  if (pre.textContent === logText) return;
  pre.textContent = logText;
}

function shouldPollBuildLog() {
  const status = state.buildStatus[state.environment];
  return status === 'building' || status === 'canceling';
}

function startBuildLogPolling() {
  if (buildLogPoller || !state.projectId) return;
  buildLogPoller = setInterval(async () => {
    if (!state.projectId) return;
    if (!shouldPollBuildLog()) {
      stopBuildLogPolling();
      return;
    }
    await loadLatestBuild(state.projectId, state.environment, { silent: true });
  }, 3000);
}

function stopBuildLogPolling() {
  if (!buildLogPoller) return;
  clearInterval(buildLogPoller);
  buildLogPoller = null;
}

function ensureBuildLogPolling() {
  if (shouldPollBuildLog()) {
    startBuildLogPolling();
  } else {
    stopBuildLogPolling();
  }
}

function blankEnvMap(value = '') {
  return {
    development: value,
    testing: value,
    production: value
  };
}

function blankDbSelection() {
  return {
    development: { schema: '', object: '', type: '', tab: 'browse' },
    testing: { schema: '', object: '', type: '', tab: 'browse' },
    production: { schema: '', object: '', type: '', tab: 'browse' }
  };
}

function blankDbControls() {
  return {
    development: { page: 1, pageSize: DEFAULT_DATABASE_PAGE_SIZE, sortColumn: '', sortDirection: 'asc', filterColumn: '', filterValue: '' },
    testing: { page: 1, pageSize: DEFAULT_DATABASE_PAGE_SIZE, sortColumn: '', sortDirection: 'asc', filterColumn: '', filterValue: '' },
    production: { page: 1, pageSize: DEFAULT_DATABASE_PAGE_SIZE, sortColumn: '', sortDirection: 'asc', filterColumn: '', filterValue: '' }
  };
}

function blankDbRows() {
  return {
    development: null,
    testing: null,
    production: null
  };
}

function blankDbHistory() {
  return {
    development: [],
    testing: [],
    production: []
  };
}

function createDatabaseState() {
  return {
    catalogs: blankDbRows(),
    catalogLoading: blankEnvMap(false),
    catalogError: blankEnvMap(''),
    selected: blankDbSelection(),
    objectDetails: blankDbRows(),
    objectLoading: blankEnvMap(false),
    objectError: blankEnvMap(''),
    rows: blankDbRows(),
    rowLoading: blankEnvMap(false),
    rowError: blankEnvMap(''),
    controls: blankDbControls(),
    sqlDraft: blankEnvMap(''),
    queryResult: blankDbRows(),
    queryLoading: blankEnvMap(false),
    queryError: blankEnvMap(''),
    history: blankDbHistory(),
    historyLoading: blankEnvMap(false),
    historyError: blankEnvMap(''),
    notice: ''
  };
}

function resetDatabaseStateForProject() {
  const next = createDatabaseState();
  for (const env of ['development', 'testing', 'production']) {
    next.sqlDraft[env] = loadStoredDatabaseSql(state.user?.id, state.projectId, env);
  }
  return next;
}

function databaseSelection(env = state.environment) {
  return state.database?.selected?.[env] || { schema: '', object: '', type: '', tab: 'browse' };
}

function databaseControls(env = state.environment) {
  return state.database?.controls?.[env] || { page: 1, pageSize: DEFAULT_DATABASE_PAGE_SIZE, sortColumn: '', sortDirection: 'asc', filterColumn: '', filterValue: '' };
}

function setDatabaseState(patch = {}) {
  setState({
    database: {
      ...state.database,
      ...patch
    }
  });
}

function stopAppLogTypewriter() {
  if (appLogTypewriter) {
    clearInterval(appLogTypewriter);
    appLogTypewriter = null;
  }
  appLogLineQueue = [];
  appLogQueueEnv = '';
}

function stopAppLogPolling() {
  if (appLogPoller) {
    clearInterval(appLogPoller);
    appLogPoller = null;
  }
  stopAppLogTypewriter();
}

function isTerminalBuildStatus(status) {
  return status === 'failed' || status === 'cancelled';
}

function resetAppLogStream(env, { clearLogs = false } = {}) {
  stopAppLogTypewriter();
  state.appLogFrozenByEnv[env] = false;
  state.appLogSnapshotByEnv[env] = '';
  state.appLogLoading[env] = false;
  state.appLogError[env] = '';
  if (clearLogs) state.appLogsByEnv[env] = '';
}

function prepareAppLogsForDeploy(env) {
  resetAppLogStream(env, { clearLogs: true });
  setState({
    appLogsByEnv: { ...state.appLogsByEnv },
    appLogSnapshotByEnv: { ...state.appLogSnapshotByEnv },
    appLogLoading: { ...state.appLogLoading },
    appLogError: { ...state.appLogError },
    appLogFrozenByEnv: { ...state.appLogFrozenByEnv }
  });
}

function shouldPollAppLogs() {
  const env = state.environment;
  return Boolean(
    state.token &&
    state.projectId &&
    state.appLogsVisible &&
    !state.appLogFrozenByEnv[env]
  );
}

function splitLogLines(text) {
  if (!text) return [];
  return String(text)
    .replace(/\r/g, '')
    .split('\n');
}

function computeLogDelta(previous, current) {
  const prev = String(previous || '').replace(/\r/g, '');
  const next = String(current || '').replace(/\r/g, '');
  if (!next) return { lines: [], reset: false };
  if (!prev) return { lines: splitLogLines(next), reset: false };
  if (prev === next) return { lines: [], reset: false };

  if (next.startsWith(prev)) {
    const deltaRaw = next.slice(prev.length).replace(/^\n/, '');
    return { lines: splitLogLines(deltaRaw).filter((line) => line !== ''), reset: false };
  }

  const prevLines = splitLogLines(prev);
  const nextLines = splitLogLines(next);
  const maxOverlap = Math.min(prevLines.length, nextLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (prevLines[prevLines.length - overlap + i] !== nextLines[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return { lines: nextLines.slice(overlap), reset: false };
    }
  }

  return { lines: nextLines, reset: true };
}

function freezeAppLogStream(env, nextSnapshot = '') {
  stopAppLogTypewriter();
  const normalizedNext = String(nextSnapshot || '').replace(/\r/g, '');
  const previousSnapshot = state.appLogSnapshotByEnv[env] || '';
  const currentText = state.appLogsByEnv[env] || '';
  let merged = currentText;
  if (!merged || previousSnapshot.length > merged.length) {
    merged = previousSnapshot;
  }
  if (!merged && normalizedNext) {
    merged = normalizedNext;
  } else if (previousSnapshot && normalizedNext) {
    const delta = computeLogDelta(previousSnapshot, normalizedNext);
    if (!delta.reset && delta.lines.length) {
      merged = `${merged}\n${delta.lines.join('\n')}`;
    }
    // If reset=true, this is likely a new container stream; keep existing logs unchanged.
  }
  if (normalizedNext) {
    state.appLogSnapshotByEnv[env] = normalizedNext;
  }
  state.appLogsByEnv[env] = merged || currentText || previousSnapshot || normalizedNext;
  state.appLogLoading[env] = false;
  state.appLogFrozenByEnv[env] = true;
}

function updateAppLogPanel({ forceScroll = false } = {}) {
  const pre = document.querySelector('pre[data-app-log-stream]');
  if (!pre) return;
  const env = state.environment;
  const text = state.appLogsByEnv[env] || '';
  const fallback = state.appLogLoading[env]
    ? 'Connecting to application logs...'
    : (state.appLogError[env] || 'No application logs yet.');
  const nextValue = text || fallback;
  if (pre.textContent === nextValue) return;

  const oldHeight = pre.scrollHeight;
  const oldTop = pre.scrollTop;
  const nearBottom = pre.scrollHeight - pre.clientHeight - pre.scrollTop <= 8;
  pre.textContent = nextValue;
  if (forceScroll || nearBottom) {
    pre.scrollTop = pre.scrollHeight;
    return;
  }
  const delta = pre.scrollHeight - oldHeight;
  pre.scrollTop = Math.max(0, oldTop + delta);
}

function appendAppLogLines(env, lines) {
  const chunks = (lines || []).map((line) => String(line)).filter((line) => line.length > 0);
  if (!chunks.length) return;
  const current = state.appLogsByEnv[env] || '';
  const joined = chunks.join('\n');
  state.appLogsByEnv[env] = current ? `${current}\n${joined}` : joined;
}

function appLogBatchSize() {
  const queued = appLogLineQueue.length;
  if (queued > 800) return 40;
  if (queued > 400) return 20;
  if (queued > 160) return 10;
  if (queued > 60) return 4;
  return 1;
}

function enqueueAppLogLines(env, lines) {
  const chunks = (lines || []).map((line) => String(line)).filter((line) => line.length > 0);
  if (!chunks.length) return;
  if (appLogQueueEnv !== env) {
    appLogQueueEnv = env;
    appLogLineQueue = [];
  }
  appLogLineQueue.push(...chunks);
  if (appLogTypewriter) return;
  appLogTypewriter = setInterval(() => {
    if (!state.appLogsVisible || state.environment !== env) {
      stopAppLogTypewriter();
      return;
    }
    const next = appLogLineQueue.shift();
    if (next == null) {
      stopAppLogTypewriter();
      return;
    }
    const batch = [next];
    const take = appLogBatchSize();
    for (let i = 1; i < take; i += 1) {
      const extra = appLogLineQueue.shift();
      if (extra == null) break;
      batch.push(extra);
    }
    appendAppLogLines(env, batch);
    updateAppLogPanel();
  }, APP_LOG_TYPE_INTERVAL_MS);
}

async function fetchApplicationLogs({ force = false, allowFrozen = false, freezeAfterFetch = false } = {}) {
  if (!state.projectId || !state.token || !state.appLogsVisible) return;
  const env = state.environment;
  if (state.appLogFrozenByEnv[env] && !allowFrozen) return;
  if (state.appLogLoading[env] && !force) return;
  if (freezeAfterFetch) stopAppLogPolling();
  state.appLogLoading[env] = true;
  state.appLogError[env] = '';
  updateAppLogPanel();
  try {
    const includePrevious = ['building', 'canceling', 'failed'].includes(state.buildStatus[env]);
    const previousOnly = Boolean(freezeAfterFetch);
    const data = await api(
      `/projects/${state.projectId}/runtime-logs?environment=${env}&lines=${APP_LOG_FETCH_LINES}${includePrevious ? '&includePrevious=true' : ''}${previousOnly ? '&previousOnly=true' : ''}`,
      { timeoutMs: 15000 }
    );
    const nextSnapshot = String(data?.logs || '').replace(/\r/g, '');
    const previousSnapshot = state.appLogSnapshotByEnv[env] || '';
    if (state.appLogFrozenByEnv[env] && !allowFrozen) return;
    if (freezeAfterFetch) {
      freezeAppLogStream(env, nextSnapshot);
      updateAppLogPanel({ forceScroll: true });
      stopAppLogPolling();
      return;
    }
    state.appLogSnapshotByEnv[env] = nextSnapshot;
    if (!previousSnapshot) {
      state.appLogsByEnv[env] = nextSnapshot;
      updateAppLogPanel({ forceScroll: true });
    } else {
      const delta = computeLogDelta(previousSnapshot, nextSnapshot);
      const status = state.buildStatus[env];
      if (delta.reset && ['canceling', 'failed'].includes(status)) {
        // Preserve prior logs only once a build has reached terminal/error states.
        // During active builds, a reset often means the new pod/container stream started.
        freezeAppLogStream(env, previousSnapshot);
        updateAppLogPanel();
        stopAppLogPolling();
        return;
      }
      if (delta.reset) {
        enqueueAppLogLines(env, ['--- log stream reset ---', ...delta.lines]);
      } else {
        enqueueAppLogLines(env, delta.lines);
      }
    }
  } catch (err) {
    state.appLogError[env] = err?.message || 'Failed to load application logs.';
    if (freezeAfterFetch) {
      freezeAppLogStream(env, state.appLogSnapshotByEnv[env] || '');
      stopAppLogPolling();
    }
    updateAppLogPanel();
  } finally {
    state.appLogLoading[env] = false;
  }
}

function startAppLogPolling() {
  if (appLogPoller || !shouldPollAppLogs()) return;
  fetchApplicationLogs({ force: true });
  appLogPoller = setInterval(() => {
    if (!shouldPollAppLogs()) {
      stopAppLogPolling();
      return;
    }
    fetchApplicationLogs();
  }, APP_LOG_POLL_INTERVAL_MS);
}

function ensureAppLogPolling() {
  if (shouldPollAppLogs()) {
    startAppLogPolling();
    return;
  }
  stopAppLogPolling();
}

async function loadTasks(projectId) {
  const tasks = await api(`/projects/${projectId}/tasks`);
  setState({ tasks });
  if (projectId === state.projectId) {
    setTaskProcessingHydration(projectId, { tasksLoaded: true });
  }
}

async function loadSessions(projectId) {
  const sessions = await api(`/projects/${projectId}/sessions`);
  setState({ sessions });
}

async function loadLatestBuild(projectId, environment, options = {}) {
  const build = await api(`/projects/${projectId}/builds/latest?environment=${environment}`);
  const prevStatus = state.buildStatus[environment];
  state.latestBuild[environment] = build;
  if (build?.status !== 'failed') {
    state.failedBuildLogVisible[environment] = false;
    state.failedBuildLogError[environment] = '';
  }
  const envState = projectEnvironmentState(projectId, environment);
  const keepPreviewState =
    environment === 'development' &&
    isBackgroundDevelopmentVerifyStatus(build?.status, envState);
  if (build?.status && !keepPreviewState) {
    state.buildStatus[environment] = build.status;
  }
  const nextStatus = state.buildStatus[environment];
  const statusChanged = prevStatus !== nextStatus;
  const canSilentUpdate =
    options.silent &&
    environment === state.environment &&
    !statusChanged &&
    (nextStatus === 'building' || nextStatus === 'canceling');
  if (canSilentUpdate) {
    updateBuildLogPanel(build);
    ensureBuildLogPolling();
    return;
  }
  setState({
    latestBuild: { ...state.latestBuild },
    buildStatus: { ...state.buildStatus }
  });
  if (projectId === state.projectId && environment === 'development') {
    setTaskProcessingHydration(projectId, { buildLoaded: true });
  }
  if (environment === state.environment) {
    ensureBuildLogPolling();
    if (
      state.appLogsVisible &&
      isTerminalBuildStatus(nextStatus)
    ) {
      fetchApplicationLogs({ force: true, allowFrozen: true, freezeAfterFetch: true });
    }
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

async function loadBuildLog(environment, { status = 'failed', commitHash = '', lines } = {}) {
  if (!state.projectId || !state.token) return;
  const lineCount = Math.max(50, Math.min(Number(lines || state.failedBuildLogLines[environment] || 200), 2000));
  state.failedBuildLogLoading[environment] = true;
  state.failedBuildLogError[environment] = '';
  setState({
    failedBuildLogLoading: { ...state.failedBuildLogLoading },
    failedBuildLogError: { ...state.failedBuildLogError }
  });
  try {
    const params = new URLSearchParams({
      environment,
      status,
      lines: String(lineCount)
    });
    if (commitHash) params.set('commitHash', commitHash);
    const data = await api(`/projects/${state.projectId}/builds/log?${params.toString()}`);
    state.failedBuildLog[environment] = data?.build_log || 'No full build logs available.';
    state.failedBuildLogLines[environment] = lineCount;
    state.failedBuildLogVisible[environment] = true;
    setState({
      failedBuildLog: { ...state.failedBuildLog },
      failedBuildLogLines: { ...state.failedBuildLogLines },
      failedBuildLogVisible: { ...state.failedBuildLogVisible }
    });
  } catch (err) {
    state.failedBuildLogError[environment] = err?.message || 'Failed to load full build logs.';
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
  const nextKey = data?.openaiApiKey || '';
  setState({
    demoMode: Boolean(data?.enabled),
    demoOpenAiKey: nextKey,
    demoOpenAiKeyDraft: nextKey
  });
}

async function loadDeploymentPolicy() {
  try {
    const data = await api('/settings/deployment-policy');
    setState({
      deploymentPolicy: {
        verifiedOnly: Boolean(data?.verifiedOnly)
      }
    });
  } catch {
    setState({
      deploymentPolicy: {
        verifiedOnly: false
      }
    });
  }
}

async function loadEnvVars(projectId, environment) {
  const data = await api(`/projects/${projectId}/env/${environment}`);
  const lines = Object.entries(data.envVars || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  state.envVarsMap[environment] = lines;
  setState({ envVarsMap: { ...state.envVarsMap } });
}

function chooseDefaultDatabaseObject(catalog) {
  for (const schema of catalog?.schemas || []) {
    if (schema?.objects?.length) {
      const object = schema.objects[0];
      return {
        schema: schema.name,
        object: object.name,
        type: object.type
      };
    }
  }
  return { schema: '', object: '', type: '' };
}

async function loadDatabaseCatalog(projectId, environment, { force = false } = {}) {
  if (!projectId || !environment) return;
  if (state.database.catalogLoading[environment]) return;
  if (!force && state.database.catalogs[environment]) return;
  const nextLoading = { ...state.database.catalogLoading, [environment]: true };
  const nextError = { ...state.database.catalogError, [environment]: '' };
  setDatabaseState({ catalogLoading: nextLoading, catalogError: nextError, notice: '' });
  try {
    const data = await api(`/projects/${projectId}/database/${environment}/catalog`, { timeoutMs: 15000 });
    const catalogs = { ...state.database.catalogs, [environment]: data };
    const selected = { ...state.database.selected };
    const current = selected[environment];
    const exists = data?.schemas?.some((schema) => schema.name === current.schema && schema.objects?.some((object) => object.name === current.object));
    if (!exists) {
      const fallback = chooseDefaultDatabaseObject(data);
      selected[environment] = {
        ...current,
        ...fallback,
        tab: current?.tab || 'browse'
      };
      state.database.controls[environment] = { page: 1, pageSize: DEFAULT_DATABASE_PAGE_SIZE, sortColumn: '', sortDirection: 'asc', filterColumn: '', filterValue: '' };
    }
    setDatabaseState({
      catalogs,
      selected,
      controls: { ...state.database.controls },
      catalogLoading: { ...state.database.catalogLoading, [environment]: false }
    });
    if (selected[environment]?.schema && selected[environment]?.object) {
      await Promise.all([
        loadDatabaseObject(projectId, environment, selected[environment].schema, selected[environment].object),
        loadDatabaseRows(projectId, environment),
        loadDatabaseHistory(projectId, environment)
      ]);
    }
  } catch (err) {
    setDatabaseState({
      catalogLoading: { ...state.database.catalogLoading, [environment]: false },
      catalogError: { ...state.database.catalogError, [environment]: err.message || 'Failed to load database catalog.' }
    });
  }
}

async function loadDatabaseObject(projectId, environment, schemaName, objectName) {
  if (!projectId || !schemaName || !objectName) return;
  setDatabaseState({
    objectLoading: { ...state.database.objectLoading, [environment]: true },
    objectError: { ...state.database.objectError, [environment]: '' }
  });
  try {
    const data = await api(
      `/projects/${projectId}/database/${environment}/objects/${encodeURIComponent(schemaName)}/${encodeURIComponent(objectName)}`,
      { timeoutMs: 15000 }
    );
    const objectDetails = { ...state.database.objectDetails, [environment]: data };
    const controls = { ...state.database.controls };
    const nextControls = { ...(controls[environment] || databaseControls(environment)) };
    if (!nextControls.sortColumn && data?.primaryKey?.[0]) {
      nextControls.sortColumn = data.primaryKey[0];
    }
    controls[environment] = nextControls;
    setDatabaseState({
      objectDetails,
      controls,
      objectLoading: { ...state.database.objectLoading, [environment]: false }
    });
  } catch (err) {
    setDatabaseState({
      objectLoading: { ...state.database.objectLoading, [environment]: false },
      objectError: { ...state.database.objectError, [environment]: err.message || 'Failed to load object details.' }
    });
  }
}

async function loadDatabaseRows(projectId, environment) {
  const selected = databaseSelection(environment);
  if (!projectId || !selected.schema || !selected.object) return;
  const controls = databaseControls(environment);
  const params = new URLSearchParams({
    page: String(controls.page || 1),
    pageSize: String(controls.pageSize || DEFAULT_DATABASE_PAGE_SIZE)
  });
  if (controls.sortColumn) params.set('sortColumn', controls.sortColumn);
  if (controls.sortDirection) params.set('sortDirection', controls.sortDirection);
  if (controls.filterColumn) params.set('filterColumn', controls.filterColumn);
  if (controls.filterValue) params.set('filterValue', controls.filterValue);
  setDatabaseState({
    rowLoading: { ...state.database.rowLoading, [environment]: true },
    rowError: { ...state.database.rowError, [environment]: '' }
  });
  try {
    const data = await api(
      `/projects/${projectId}/database/${environment}/objects/${encodeURIComponent(selected.schema)}/${encodeURIComponent(selected.object)}/rows?${params.toString()}`,
      { timeoutMs: 15000 }
    );
    setDatabaseState({
      rows: { ...state.database.rows, [environment]: data },
      rowLoading: { ...state.database.rowLoading, [environment]: false }
    });
  } catch (err) {
    setDatabaseState({
      rowLoading: { ...state.database.rowLoading, [environment]: false },
      rowError: { ...state.database.rowError, [environment]: err.message || 'Failed to load rows.' }
    });
  }
}

async function loadDatabaseHistory(projectId, environment) {
  if (!projectId || !environment) return;
  setDatabaseState({
    historyLoading: { ...state.database.historyLoading, [environment]: true },
    historyError: { ...state.database.historyError, [environment]: '' }
  });
  try {
    const data = await api(`/projects/${projectId}/database/${environment}/history?limit=12`, { timeoutMs: 12000 });
    setDatabaseState({
      history: { ...state.database.history, [environment]: data?.entries || [] },
      historyLoading: { ...state.database.historyLoading, [environment]: false }
    });
  } catch (err) {
    setDatabaseState({
      historyLoading: { ...state.database.historyLoading, [environment]: false },
      historyError: { ...state.database.historyError, [environment]: err.message || 'Failed to load query history.' }
    });
  }
}

async function runDatabaseQuery(projectId, environment) {
  if (!projectId || !environment) return;
  const sql = state.database.sqlDraft[environment] || '';
  setDatabaseState({
    queryLoading: { ...state.database.queryLoading, [environment]: true },
    queryError: { ...state.database.queryError, [environment]: '' },
    notice: ''
  });
  try {
    const data = await api(`/projects/${projectId}/database/${environment}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
      timeoutMs: 15000
    });
    setDatabaseState({
      queryResult: { ...state.database.queryResult, [environment]: data },
      queryLoading: { ...state.database.queryLoading, [environment]: false },
      notice: `Query completed in ${data.durationMs}ms.`
    });
    await loadDatabaseHistory(projectId, environment);
  } catch (err) {
    setDatabaseState({
      queryLoading: { ...state.database.queryLoading, [environment]: false },
      queryError: { ...state.database.queryError, [environment]: err.message || 'Query failed.' }
    });
  }
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

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function closeEnvActionMenus(root = document) {
  root.querySelectorAll('.env-pill-menu[open]').forEach((menu) => {
    menu.removeAttribute('open');
  });
}

function closeTaskActionMenus(root = document) {
  root.querySelectorAll('[data-task-menu][open]').forEach((menu) => {
    menu.removeAttribute('open');
  });
}

function renderDevelopmentActionMenu({ commitHash, taskId = '', label = 'Development actions' } = {}) {
  if (!commitHash) return '';
  return `
    <details class="task-action-menu" data-task-menu>
      <summary class="icon-button action-menu-button" aria-label="${escapeHtml(label)}">${icon('more-vertical')}</summary>
      <div class="menu">
        <button class="menu-item task-menu-item" type="button" data-task-action="start-preview" data-task-id="${taskId || ''}" data-commit="${commitHash}">Start Preview</button>
        <button class="menu-item task-menu-item" type="button" data-task-action="start-full-build" data-task-id="${taskId || ''}" data-commit="${commitHash}">Start Full Build</button>
      </div>
    </details>
  `;
}

function renderDevelopmentTaskStateBadge(item, project) {
  const envState = projectEnvironmentState(project, 'development');
  if (!envState || !item?.id || !item?.commit_hash) return '';
  const liveTaskMatches =
    String(envState.live_task_id || '') === String(item.id) &&
    String(envState.live_commit_sha || '') === String(item.commit_hash || '');
  if (String(envState.build_status || '').toLowerCase() === 'live' && liveTaskMatches) {
    const liveMode = developmentLiveMode(project);
    return `
      <span class="badge live ${liveMode === 'verified' ? 'full-build-live' : ''}">
        ${liveMode === 'verified' ? `${icon('check')} ` : ''}Live
      </span>
    `;
  }
  const selectedTaskMatches =
    String(envState.selected_task_id || '') === String(item.id) &&
    String(envState.selected_commit_sha || '') === String(item.commit_hash || '');
  if (selectedTaskMatches && isDevelopmentTransitioning(envState)) {
    return '<span class="badge building">Starting</span>';
  }
  return '';
}

function formatBytes(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = num;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size >= 10 || idx === 0 ? Math.round(size) : size.toFixed(1)} ${units[idx]}`;
}

function formatCellValue(value) {
  if (value == null) return '<span class="db-null">NULL</span>';
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

function renderDataGrid(columns = [], rows = [], emptyMessage = 'No rows returned.') {
  if (!columns.length) return `<div class="db-empty">${emptyMessage}</div>`;
  return `
    <div class="db-grid-wrap">
      <table class="db-grid">
        <thead>
          <tr>${columns.map((column) => `<th>${escapeHtml(column.name || column)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((row) => `
            <tr>${columns.map((column) => `<td>${formatCellValue(row[column.name || column])}</td>`).join('')}</tr>
          `).join('') : `<tr><td colspan="${columns.length}">${emptyMessage}</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
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
  if (status === 'building' || status === 'running' || status === 'queued' || status === 'canceling') return 'badge building';
  if (status === 'failed' || status === 'cancelled') return 'badge failed';
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
      stopAppLogPolling();
      resetTaskProcessingState(nextProjectId);
      setState({
        projects: remaining,
        projectId: nextProjectId,
        runtimeQuotaNotice: nextRuntimeNotice,
        appLogsByEnv: blankEnvMap(''),
        appLogSnapshotByEnv: blankEnvMap(''),
        appLogLoading: blankEnvMap(false),
        appLogError: blankEnvMap(''),
        appLogFrozenByEnv: blankEnvMap(false)
      });
      if (!nextProjectId) {
        stopAppLogPolling();
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
          appLogsVisible: false,
          appLogsByEnv: blankEnvMap(''),
          appLogSnapshotByEnv: blankEnvMap(''),
          appLogLoading: blankEnvMap(false),
          appLogError: blankEnvMap(''),
          appLogFrozenByEnv: blankEnvMap(false),
          createProjectNotice: ''
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
      let nextTask = payload;
      if (idx >= 0) {
        state.tasks[idx] = { ...state.tasks[idx], ...payload };
        nextTask = state.tasks[idx];
        setState({ tasks: [...state.tasks] });
      }
      if (payload.id && state.taskSubmissionPending?.projectId === state.projectId) {
        setState({ taskSubmissionPending: null });
      }
      notifyTaskTerminalResult(nextTask, payload.status);
    });
    socketClient.on('taskDeleted', (payload) => {
      const nextTasks = state.tasks.filter((t) => t.id !== payload.id);
      if (nextTasks.length !== state.tasks.length) {
        delete state.taskDetails[payload.id];
        setState({
          tasks: nextTasks,
          taskDetails: { ...state.taskDetails }
        });
      }
    });
    socketClient.on('buildUpdated', (payload) => {
      const env = payload.environment;
      const prevStatus = state.buildStatus[env] || 'offline';
      const envState = projectEnvironmentState(state.projectId, env);
      const keepPreviewState =
        env === 'development' &&
        isBackgroundDevelopmentVerifyStatus(payload.status, envState);
      if (!keepPreviewState) {
        state.buildStatus[env] = payload.status;
      }
      if (payload.refCommit) {
        state.deployedCommit[env] = payload.refCommit;
      }
      if (payload.updatedAt) {
        state.updatedAt[env] = payload.updatedAt;
      }
      if (payload.status === 'live' || payload.status === 'failed' || payload.status === 'cancelled') {
        state.pendingDeployCommit[env] = '';
      }
      if (payload.status === 'offline') {
        state.pendingDeployCommit[env] = '';
      }
      if (payload.status === 'building' && !keepPreviewState) {
        state.progressVisibleUntil[env] = 0;
        if (payload.refCommit) {
          state.pendingDeployCommit[env] = payload.refCommit;
        }
        if (env === state.environment && state.appLogsVisible) {
          fetchApplicationLogs({ force: true });
        }
      }
      if (
        env === state.environment &&
        state.appLogsVisible &&
        isTerminalBuildStatus(payload.status)
      ) {
        fetchApplicationLogs({ force: true, allowFrozen: true, freezeAfterFetch: true });
      }
      if (!keepPreviewState && prevStatus === 'building' && (payload.status === 'live' || payload.status === 'failed' || payload.status === 'cancelled')) {
        state.progressVisibleUntil[env] = Date.now() + 3000;
        scheduleHeaderProgressRefresh();
      }
      if (env === state.environment && (payload.status === 'failed' || payload.status === 'live' || payload.status === 'cancelled' || payload.status === 'building')) {
        loadLatestBuild(state.projectId, env);
      }
      if (payload.status === 'live') {
        loadLastSuccessBuilds(state.projectId);
      }
      if (env === state.environment) {
        ensureBuildLogPolling();
        ensureAppLogPolling();
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
      notifyDevelopmentBuildTerminal(payload);
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
    stopBuildLogPolling();
    stopAppLogPolling();
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
          <div class="header-container">
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
              ${this.renderEnvBadges()}
              ${this.renderProjectSelect(project)}
              ${this.renderNerdLevel()}
            </div>
            <div class="header-actions">
              ${this.renderPlanBadge()}
              ${this.renderAccountMenu()}
            </div>
          </div>
          </div>
        ${this.renderHeaderProgress()}
        </header>
        <main>
          ${this.renderMain(project)}
        </main>
        ${this.renderToasts()}
        ${this.renderModal()}
        ${this.renderConfirmModal()}
        ${this.renderPromptModal()}
        ${this.renderAndroidSetupModal()}
        ${this.renderIosSetupModal()}
        ${this.renderDeletingModal()}
        ${this.renderSettings()}
      ` : `
        ${this.renderAuth()}
        ${this.renderToasts()}
      `}
    `;
    this.bind();
  }

  renderToasts() {
    if (!state.toasts.length) return '';
    return `
      <div class="toast-stack" aria-live="polite" aria-atomic="true">
        ${state.toasts.map((toast) => `
          <div class="toast toast-${escapeHtml(toast.tone || 'info')}" data-toast-id="${toast.id}">
            <div class="toast-body">${toast.allowHtml ? toast.html : escapeHtml(toast.message || '')}</div>
            <button class="toast-dismiss" type="button" data-dismiss-toast="${toast.id}" aria-label="Dismiss notification">Close</button>
          </div>
        `).join('')}
      </div>
    `;
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
        <symbol id="icon-check" viewBox="0 0 24 24">
          <path d="M20 6L9 17l-5-5"></path>
        </symbol>
        <symbol id="icon-stop-octagon" viewBox="0 0 24 24">
          <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"></path>
        </symbol>
        <symbol id="icon-more-vertical" viewBox="0 0 24 24">
          <circle cx="12" cy="5" r="1.8"></circle>
          <circle cx="12" cy="12" r="1.8"></circle>
          <circle cx="12" cy="19" r="1.8"></circle>
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
    const project = currentProjectState();
    const envs = ['development', 'testing', 'production'];
    const statusText = (status) => {
      if (status === 'live') return 'Live';
      if (status === 'building') return 'Building';
      if (status === 'failed') return 'Failed';
      if (status === 'canceling') return 'Canceling';
      if (status === 'cancelled') return 'Cancelled';
      return 'Offline';
    };
    const statusClass = (status) => {
      if (['preview_live', 'verified_live', 'live'].includes(status)) return 'live';
      if (['preview_starting', 'building', 'canceling'].includes(status)) return 'building';
      if (['preview_failed', 'failed', 'cancelled', 'offline', 'preview_sleeping'].includes(status)) return 'offline';
      return 'offline';
    };
    const statusLabel = (env, status) => {
      if (env !== 'development') return statusText(status);
      const projectEnv = projectEnvironmentState(project, env);
      const primary = developmentPrimaryStatus(project, status);
      if (primary === 'preview_live' || primary === 'verified_live') return 'Live';
      if (primary === 'preview_starting') return 'Starting';
      if (primary === 'preview_sleeping') return 'Sleeping';
      if (primary === 'preview_failed') return 'Failed';
      if (primary === 'building' && projectEnv?.preview_mode === 'workspace') return 'Verifying';
      return statusText(status);
    };
    const actionForStatus = (status) => {
      if (status === 'building' || status === 'canceling') return { type: 'cancel' };
      if (status === 'live') return { type: 'stop' };
      return null;
    };
    return state.nerdLevel === 'beginner' ? '' : `
      <div class="env-badges">
        ${envs.map((env,idx) => {
          const status = state.buildStatus[env] || 'offline';
          const envState = projectEnvironmentState(project, env);
          const isActive = state.environment === env;
          const action = env === 'development' ? null : actionForStatus(status);
          const success = state.lastSuccessBuild?.[env];
          const successAt = success?.updated_at || success?.created_at || '';
          const duration = formatDurationMs(success?.duration_ms);
          const durationText = duration && duration !== 'n/a' ? ` · ${duration}` : '';
          const metaText = env === 'development'
            ? developmentModeLabel(project)
            : (successAt
                ? `Last success ${formatRelative(successAt)}${durationText}`
                : 'No successful deploy yet');
          const devMenu = env === 'development' ? (() => {
            const awake = isDevelopmentAwake(envState);
            const openable = isDevelopmentOpenable(envState);
            const selectedMode = developmentSelectedMode(project);
            const wakeLabel = selectedMode === 'workspace' ? 'Wake Preview' : 'Wake Full Build';
            const verifiedOnly = Boolean(state.deploymentPolicy?.verifiedOnly);
            return `
              <details class="env-pill-menu" data-env-menu="${env}">
                <summary class="env-pill-action env-pill-action-menu" aria-label="Development actions">${icon('more-vertical')}</summary>
                <div class="menu">
                  ${openable ? `<button class="menu-item env-menu-item" type="button" data-env="${env}" data-action="open-development">Open Development</button>` : ''}
                  <div class="env-mode-toggle-group">
                    <label class="env-mode-toggle-row ${selectedMode === 'workspace' ? 'is-active' : ''} ${verifiedOnly ? 'is-disabled' : ''}">
                      <span class="env-mode-toggle-label">Preview Mode</span>
                      <span class="toggle env-mode-toggle">
                        <input
                          class="env-mode-toggle-input"
                          type="checkbox"
                          data-env="${env}"
                          data-mode="workspace"
                          ${selectedMode === 'workspace' ? 'checked' : ''}
                          ${verifiedOnly ? 'disabled' : ''}
                        />
                        <span class="toggle-track"><span class="toggle-thumb"></span></span>
                      </span>
                    </label>
                    <label class="env-mode-toggle-row ${selectedMode === 'verified' ? 'is-active' : ''}">
                      <span class="env-mode-toggle-label">Full Build Mode</span>
                      <span class="toggle env-mode-toggle">
                        <input
                          class="env-mode-toggle-input"
                          type="checkbox"
                          data-env="${env}"
                          data-mode="verified"
                          ${selectedMode === 'verified' ? 'checked' : ''}
                        />
                        <span class="toggle-track"><span class="toggle-thumb"></span></span>
                      </span>
                    </label>
                  </div>
                  <div class="menu-info-row">
                    <span>Mode controls what Wake Development launches.</span>
                    <div class="info-popover">
                      <button class="info-icon" type="button" aria-label="Development mode info" aria-expanded="false">i</button>
                      <div class="info-tooltip" role="tooltip">
                        Preview Mode runs the development workspace for fast testing and can reflect multiple task changes. Full Build Mode runs the clean built version of a selected task commit and is closer to QA behavior.
                      </div>
                    </div>
                  </div>
                  <button class="menu-item env-menu-item" type="button" data-env="${env}" data-action="${awake ? 'sleep-development' : 'wake-development'}">${awake ? 'Sleep Development' : wakeLabel}</button>
                </div>
              </details>
            `;
          })() : '';
          return `
            <div class="env-pill ${isActive ? 'active' : ''} ${idx === 0 ? 'env-left' : idx === 1 ? 'env-middle' : 'env-right'}" data-env="${env}" role="button" tabindex="0" aria-pressed="${isActive}">
              ${devMenu}
              ${action ? `<span class="env-pill-action action-${action.type}" data-env="${env}" data-action="${action.type}" title="${action.type === 'cancel' ? 'Abort build' : 'Stop deployment'}">X</span>` : ''}
              <span class="tag">${env}</span>
              <span class="status-text ${statusClass(env === 'development' ? developmentPrimaryStatus(project, status) : status)}">${statusLabel(env, status)}</span>
              <span class="env-meta">${metaText}</span>
            </div>
          `;
        }).join('')}
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
              <div class="hero-intro">
                <div class="hero-ribbon" aria-label="Coming soon">Coming Soon!</div>
                <p class="eyebrow">The future of website development is here</p>
              </div>
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

        </main>

        <div class="auth-modal ${state.authModalOpen ? 'open' : ''}" aria-hidden="${state.authModalOpen ? 'false' : 'true'}">
          <div class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button class="auth-close" type="button" aria-label="Close">Close</button>
            <div class="auth-panel" data-auth-panel="register" ${state.authModalMode === 'register' ? '' : 'style="display:none;"'}>
              <h2 id="auth-title">Register your workspace</h2>
              <p>Start with a single prompt. Scale when it clicks.</p>
              ${state.authModalMode === 'register' && state.authErrorMessage ? `<div class="notice plan-error auth-panel-error">${escapeHtml(state.authErrorMessage)}</div>` : ''}
              <div class="grid">
                <input id="registerEmail" type="email" placeholder="Email" />
                <input id="registerPassword" type="password" placeholder="Password (optional)" />
                <button id="registerBtn">Register</button>
              </div>
              <p class="auth-switch-copy">Already have access? <button class="auth-switch" type="button" data-auth-switch="login">Log in</button></p>
            </div>
            <div class="auth-panel" data-auth-panel="login" ${state.authModalMode === 'login' ? '' : 'style="display:none;"'}>
              <h2>Welcome back</h2>
              <p>Pick up where your team left off.</p>
              ${state.authModalMode === 'login' && state.authErrorMessage ? `<div class="notice plan-error auth-panel-error">${escapeHtml(state.authErrorMessage)}</div>` : ''}
              <div class="grid">
                <input id="loginEmail" type="email" placeholder="Email" />
                <input id="loginPassword" type="password" placeholder="Password (optional)" />
                <button id="loginBtn">Log in</button>
              </div>
              <p class="auth-switch-copy">Need an invite? <button class="auth-switch" type="button" data-auth-switch="register">Register</button></p>
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
        ${state.projectNotice ? `<div class="notice plan-error">${state.projectNotice}</div>` : ''}
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
        ${state.createProjectNotice ? `<div class="notice plan-error">${state.createProjectNotice}</div>` : ''}
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
    const plan = state.user?.plan || state.runtimeUsage?.plan;
    if (!plan) return '';
    return `<div class="plan-badge">Plan: ${titleCase(plan)}</div>`;
  }

  renderRuntimeBadge() {
    if (state.runtimeUsageLoading) {
      return `<div class="runtime-badge runtime-loading">Runtime: …</div>`;
    }
    const usage = state.runtimeUsage?.usage?.[state.environment];
    if (!usage && state.runtimeUsageError) {
      return `<div class="runtime-badge runtime-loading" title="${escapeHtml(state.runtimeUsageError)}">Runtime: …</div>`;
    }
    const used = formatHours(usage?.used_hours || 0);
    const limitHours = runtimeLimitHoursForCurrentEnv();
    const limit = limitHours == null ? 'Unlimited' : `${formatHours(limitHours)}h`;
    const envLabel = titleCase(state.environment) == 'Production' ? 'Prod' : titleCase(state.environment) == 'Testing' ? 'Test' : 'Dev';
    return `
      <div class="runtime-badge" title="${envLabel} runtime this month">
        <span>${envLabel} runtime: ${used}h / ${limit}</span>
      </div>
    `;
  }

  renderSubmit(project) {
    const env = state.environment;
    const isBeginner = state.nerdLevel === 'beginner';
    const isDevelopment = env === 'development';
    const envState = isDevelopment ? projectEnvironmentState(project, env) : null;
    const latestBuild = isDevelopment ? state.latestBuild.development : null;
    const developmentMode = isDevelopment ? developmentModeLabel(project) : '';
    const verificationSummary = isDevelopment ? developmentVerificationStatus(project) : '';
    const verificationBadgeClass = developmentSecondaryBadgeClass(verificationSummary);
    const verificationFailed = Boolean(isDevelopment && latestBuild?.status === 'failed');
    const verificationRunning = Boolean(isDevelopment && latestBuild?.status === 'building');
    const verificationVerified = Boolean(
      isDevelopment &&
      envState?.verified_commit_sha &&
      envState?.commit_sha &&
      envState.verified_commit_sha === envState.commit_sha &&
      envState.workspace_dirty === false
    );
    const verifyLogText = state.failedBuildLog[env] || '';
    const verifyLogError = state.failedBuildLogError[env] || '';
    const verifyLogLoading = Boolean(state.failedBuildLogLoading[env]);
    const verifyLogVisible = Boolean(state.failedBuildLogVisible[env]);
    const verifyLogPreview = verifyLogText || (verifyLogLoading ? 'Loading full build logs...' : (verifyLogError || 'No full build logs available.'));
    const appLogText = state.appLogsByEnv[env] || '';
    const appLogError = state.appLogError[env] || '';
    const appLogLoading = Boolean(state.appLogLoading[env]);
    const appLogPreview = appLogText || (appLogLoading ? 'Connecting to application logs...' : (appLogError || 'No application logs yet.'));
    const processingView = deriveTaskProcessingView();
    return `
      <div class="card">
        <div class="section-title">
          <h2>Submit Task</h2>
          <span class="badge ${badgeClass(state.buildStatus[env])}">${state.buildStatus[env]}</span>
        </div>
        ${processingView ? `
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
            <div class="status-text">${processingView.message}</div>
          </div>
        ` : ''}
        <p class="notice"><a class="tag view-project-link" href="${projectProtocol()}://${projectUrl(project, env)}" target="_blank" rel="noreferrer">${isDevelopment ? 'Open Development' : 'View your project'}</a></p>
        ${isDevelopment ? `
          <div class="submit-mode-note">
            <div class="submit-mode-copy">
              <div class="submit-mode-header">
                <span class="tag">${escapeHtml(developmentMode || 'Development')}</span>
                ${verificationSummary ? `<span class="badge ${verificationBadgeClass}">${verificationSummary}</span>` : ''}
              </div>
              <p class="notice">Development uses one URL and two modes. Preview Mode runs the workspace directly for fast iteration. It can reflect multiple task changes and may differ from a clean build. Full Build Mode runs a clean built version of the selected task commit, closer to QA behavior.</p>
              ${verificationRunning ? '<p class="notice">A clean full build is running for Development.</p>' : ''}
              ${verificationVerified ? '<p class="notice">The current Development URL is serving a clean full build.</p>' : ''}
            </div>
            <div class="info-popover">
              <button class="info-icon" type="button" aria-label="Development preview info" aria-expanded="false">i</button>
              <div class="info-tooltip" role="tooltip">
                Development has one URL. Preview Mode runs the current workspace for fast feedback and may include multiple task changes. Full Build Mode serves a clean built version of a selected task commit. Testing and Production always run full builds.
              </div>
            </div>
          </div>
          ${verificationFailed ? `
            <div class="verification-state verification-state-failed">
              <div>
                <strong>Full build failed.</strong>
                <span class="notice">Your live preview can still run, but this code did not build or start cleanly in a deployment-style runtime.</span>
              </div>
              <button class="ghost" id="toggleVerifyLogs">${verifyLogVisible ? 'Hide' : 'View'} full build logs</button>
            </div>
            ${verifyLogVisible ? `
              <div class="app-log-stream-wrap verification-log-panel">
                <div class="log-header">
                  <span>Full Build Logs <span class="meta">${verifyLogLoading ? 'loading...' : 'latest failed full build'}</span></span>
                  <button class="icon-button" id="copyVerifyLogs" title="Copy Full Build Logs" aria-label="Copy Full Build Logs">${icon('copy')}</button>
                </div>
                <pre class="app-log-stream" data-verify-log-stream="true">${escapeHtml(verifyLogPreview)}</pre>
              </div>
            ` : ''}
          ` : ''}
        ` : ''}
        <textarea id="taskPrompt" placeholder="A good title for the feature or fix you want to make...\n\nDescribe exactly what you want to see, what you expect \nto happen when you click somewhere etc...\n\nWatch your ideas come to life!\nIn moments you will be viewing the updates${isBeginner ? '.' : '\nand reading a summary of what we have done!'}">${state.taskPromptDraft || ''}</textarea>
        <div class="row m-top-sm submit-controls">
          <div class="row">
            <button id="submitTask">Submit</button>
          </div>
          <label class="toggle app-log-toggle">
            <input id="toggleAppLogs" type="checkbox" ${state.appLogsVisible ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span>Show Application Logs</span>
          </label>
        </div>
        ${state.appLogsVisible ? `
          <div class="app-log-stream-wrap">
            <div class="log-header">
              <span>Application Logs <span class="meta">${appLogLoading ? 'connecting...' : 'streaming'}</span></span>
              <button class="icon-button" id="copyAppLogs" title="Copy Application Logs" aria-label="Copy Application Logs">${icon('copy')}</button>
            </div>
            <pre class="app-log-stream" data-app-log-stream="true">${escapeHtml(appLogPreview)}</pre>
          </div>
        ` : ''}
      </div>
    `;
  }

  renderDatabaseCard(project) {
    if (!project) return '';
    const env = state.environment;
    const catalog = state.database.catalogs[env];
    const selection = databaseSelection(env);
    const details = state.database.objectDetails[env];
    const rows = state.database.rows[env];
    const history = state.database.history[env] || [];
    const controls = databaseControls(env);
    const sqlDraft = state.database.sqlDraft[env] || '';
    const queryResult = state.database.queryResult[env];
    const isProduction = env === 'production';
    const modeLabel = isProduction ? 'Read-only production' : 'Read-only';
    return `
      <section class="card database-workspace">
        <div class="section-title database-header">
          <div>
            <h2>Database</h2>
            <p class="notice">Project-scoped and environment-scoped access for <strong>${escapeHtml(project.name)}</strong> in <strong>${titleCase(env)}</strong>.</p>
          </div>
          <div class="database-header-actions">
            <span class="badge ${isProduction ? 'failed' : 'live'}">${modeLabel}</span>
            <button class="ghost" id="refreshDatabase" ${state.database.catalogLoading[env] ? 'disabled' : ''}>${state.database.catalogLoading[env] ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </div>
        ${state.database.notice ? `<p class="notice">${escapeHtml(state.database.notice)}</p>` : ''}
        ${state.database.catalogError[env] ? `<p class="notice notice-warning">${escapeHtml(state.database.catalogError[env])}</p>` : ''}
        <div class="database-shell">
          <aside class="database-sidebar">
            <div class="db-sidebar-head">
              <strong>Schemas</strong>
              <span class="meta">${catalog?.schemas?.length || 0} visible</span>
            </div>
            ${catalog?.schemas?.length ? catalog.schemas.map((schema) => `
              <div class="db-schema-group">
                <div class="db-schema-name">${escapeHtml(schema.name)}</div>
                ${schema.objects.map((object) => {
                  const active = selection.schema === schema.name && selection.object === object.name;
                  return `
                    <button
                      class="db-object-button ${active ? 'active' : ''}"
                      data-db-select="true"
                      data-schema="${escapeHtml(schema.name)}"
                      data-object="${escapeHtml(object.name)}"
                      data-type="${escapeHtml(object.type)}"
                    >
                      <span>${escapeHtml(object.name)}</span>
                      <span class="meta">${object.type === 'table' ? `${object.estimatedRows || 0} rows` : object.type}</span>
                    </button>
                  `;
                }).join('')}
              </div>
            `).join('') : `<div class="db-empty">${state.database.catalogLoading[env] ? 'Loading database catalog...' : 'No tables or views found for this environment yet.'}</div>`}
          </aside>
          <div class="database-main">
            <div class="database-object-summary">
              <div>
                <h3>${selection.object ? `${escapeHtml(selection.schema)}.${escapeHtml(selection.object)}` : 'Choose a table or view'}</h3>
                <p class="notice">${details ? `${titleCase(details.type)} with ${details.columns.length} columns, ~${details.estimatedRows} rows, ${formatBytes(details.totalBytes)}.` : 'Select a database object to inspect schema, browse rows, or run SQL against this environment.'}</p>
              </div>
              <div class="database-tabs">
                <button class="${selection.tab === 'browse' ? 'active' : ''}" data-db-tab="browse">Browse</button>
                <button class="${selection.tab === 'sql' ? 'active' : ''}" data-db-tab="sql">SQL</button>
                <button class="${selection.tab === 'history' ? 'active' : ''}" data-db-tab="history">History</button>
              </div>
            </div>
            ${details ? `
              <div class="db-meta-grid">
                <div class="db-meta-card">
                  <strong>Columns</strong>
                  <ul>${details.columns.map((column) => `<li><code>${escapeHtml(column.name)}</code> <span class="meta">${escapeHtml(column.dataType)}${column.nullable ? '' : ' • required'}</span></li>`).join('')}</ul>
                </div>
                <div class="db-meta-card">
                  <strong>Keys and indexes</strong>
                  <ul>
                    <li><span class="meta">Primary key:</span> ${details.primaryKey?.length ? details.primaryKey.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ') : 'None'}</li>
                    <li><span class="meta">Foreign keys:</span> ${details.foreignKeys?.length ? `${details.foreignKeys.length} linked column${details.foreignKeys.length === 1 ? '' : 's'}` : 'None'}</li>
                    <li><span class="meta">Indexes:</span> ${details.indexes?.length || 0}</li>
                  </ul>
                </div>
              </div>
            ` : ''}
            ${selection.tab === 'browse' ? `
              <div class="db-panel">
                <div class="db-toolbar">
                  <label>
                    <span>Filter column</span>
                    <select id="dbFilterColumn">
                      <option value="">Any</option>
                      ${(details?.columns || []).map((column) => `<option value="${escapeHtml(column.name)}" ${controls.filterColumn === column.name ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                    </select>
                  </label>
                  <label class="db-filter-grow">
                    <span>Contains</span>
                    <input id="dbFilterValue" type="text" value="${escapeHtml(controls.filterValue || '')}" placeholder="Search rows" />
                  </label>
                  <label>
                    <span>Sort</span>
                    <select id="dbSortColumn">
                      <option value="">Default</option>
                      ${(details?.columns || []).map((column) => `<option value="${escapeHtml(column.name)}" ${controls.sortColumn === column.name ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                    </select>
                  </label>
                  <label>
                    <span>Direction</span>
                    <select id="dbSortDirection">
                      <option value="asc" ${controls.sortDirection !== 'desc' ? 'selected' : ''}>Asc</option>
                      <option value="desc" ${controls.sortDirection === 'desc' ? 'selected' : ''}>Desc</option>
                    </select>
                  </label>
                  <label>
                    <span>Rows</span>
                    <select id="dbPageSize">
                      ${DATABASE_PAGE_SIZE_OPTIONS.map((size) => `<option value="${size}" ${Number(controls.pageSize || DEFAULT_DATABASE_PAGE_SIZE) === size ? 'selected' : ''}>${size}</option>`).join('')}
                    </select>
                  </label>
                  <button id="applyDbBrowse" ${!selection.object ? 'disabled' : ''}>Apply</button>
                </div>
                <div class="db-toolbar db-pagination">
                  <span class="meta">Page ${rows?.page || controls.page || 1} • ${rows?.pageSize || controls.pageSize || DEFAULT_DATABASE_PAGE_SIZE} rows per page${rows?.hasMore ? ' • more rows available' : ''}</span>
                  <div class="row">
                    <button class="ghost" id="dbPrevPage" ${(controls.page || 1) <= 1 || state.database.rowLoading[env] ? 'disabled' : ''}>Previous</button>
                    <button class="ghost" id="dbNextPage" ${!rows?.hasMore || state.database.rowLoading[env] ? 'disabled' : ''}>Next</button>
                  </div>
                </div>
                ${state.database.objectError[env] ? `<p class="notice notice-warning">${escapeHtml(state.database.objectError[env])}</p>` : ''}
                ${state.database.rowError[env] ? `<p class="notice notice-warning">${escapeHtml(state.database.rowError[env])}</p>` : ''}
                ${state.database.rowLoading[env] ? '<div class="db-empty">Loading rows...</div>' : renderDataGrid(rows?.columns || details?.columns || [], rows?.rows || [], 'No rows returned for this object.')}
              </div>
            ` : ''}
            ${selection.tab === 'sql' ? `
              <div class="db-panel">
                <div class="db-toolbar">
                  <span class="meta">Read-only SQL. Allowed statements: <code>SELECT</code>, <code>WITH</code>, <code>EXPLAIN</code>.</span>
                  <button id="runDbQuery" ${state.database.queryLoading[env] ? 'disabled' : ''}>${state.database.queryLoading[env] ? 'Running...' : 'Run Query'}</button>
                </div>
                <textarea id="dbSqlEditor" class="db-sql-editor" placeholder="select * from public.users order by id desc limit 50;">${escapeHtml(sqlDraft)}</textarea>
                ${state.database.queryError[env] ? `<p class="notice notice-warning">${escapeHtml(state.database.queryError[env])}</p>` : ''}
                ${queryResult ? `
                  <div class="db-query-summary">
                    <span class="meta">${queryResult.rowCount} row${queryResult.rowCount === 1 ? '' : 's'} returned in ${queryResult.durationMs}ms${queryResult.truncated ? ' • truncated to platform cap' : ''}</span>
                  </div>
                  ${renderDataGrid(queryResult.columns || [], queryResult.rows || [], 'The query completed but returned no rows.')}
                ` : '<div class="db-empty">Run a read-only query to inspect data without leaving the app.</div>'}
              </div>
            ` : ''}
            ${selection.tab === 'history' ? `
              <div class="db-panel">
                ${state.database.historyLoading[env] ? '<div class="db-empty">Loading history...</div>' : ''}
                ${state.database.historyError[env] ? `<p class="notice notice-warning">${escapeHtml(state.database.historyError[env])}</p>` : ''}
                ${history.length ? `
                  <div class="db-history-list">
                    ${history.map((entry) => `
                      <div class="db-history-item">
                        <div class="row spread">
                          <strong>${escapeHtml(entry.action.replace(/_/g, ' '))}</strong>
                          <span class="meta">${formatRelative(entry.created_at)}</span>
                        </div>
                        <div class="meta">${entry.query_preview ? escapeHtml(entry.query_preview) : `${escapeHtml(entry.schema_name || '')}${entry.object_name ? `.${escapeHtml(entry.object_name)}` : ''}`}</div>
                        <div class="meta">${entry.success ? 'success' : `failed${entry.error_code ? ` • ${escapeHtml(entry.error_code)}` : ''}`}${entry.duration_ms ? ` • ${entry.duration_ms}ms` : ''}</div>
                      </div>
                    `).join('')}
                  </div>
                ` : '<div class="db-empty">Database history will appear here after you browse objects or run queries.</div>'}
              </div>
            ` : ''}
            <div class="db-danger-zone">
              <div>
                <h3>Danger Zone</h3>
                <p class="notice">This queues a full reset of the <strong>${titleCase(env)}</strong> customer database for this project. Use it only when you intend to erase all data.</p>
              </div>
              <button class="ghost danger" id="emptyDb" ${!state.projectId ? 'disabled' : ''}>Empty Database</button>
            </div>
          </div>
        </div>
      </section>
    `;
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
    const isStarterPlan = String(state.user?.plan || '').toLowerCase() === 'starter';
    return `
      <div class="card grid two">
        <div>
          <h3>Repo Upload / Download</h3>
          <input id="repoFile" class="file-input" type="file" accept=".bundle,.gitbundle,.zip,.tar,.tar.gz,.tgz,application/octet-stream,application/zip,application/gzip,application/x-gtar,application/x-tar" />
          <div class="row">
            <button id="uploadRepo" class="file-button" ${state.uploadBusy ? 'disabled' : ''}>${state.uploadBusy ? 'Uploading...' : 'Upload Repo'}</button>
            <button class="ghost" id="downloadRepo" ${state.downloadBusy ? 'disabled' : ''}>${state.downloadBusy ? 'Downloading...' : 'Download'}</button>
          </div>
          <p class="notice">${state.repoMessage || 'Validations will be enforced on upload.'}</p>
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
        ${DESKTOP_BRIDGE && !isStarterPlan ? `
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
      ${this.renderDatabaseCard(project)}
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
    const detailState = state.taskDetails[task.id] || { open: false };
    const isDevelopment = state.environment === 'development';
    const project = currentProjectState();
    const developmentTaskStateBadge = isDevelopment ? renderDevelopmentTaskStateBadge(task, project) : '';
    const isLive = !isDevelopment && task.commit_hash && task.commit_hash === state.deployedCommit[state.environment] && state.buildStatus[state.environment] === 'live';
    const isDeploying = !isDevelopment && task.commit_hash && task.commit_hash === state.pendingDeployCommit[state.environment] && ['building', 'canceling'].includes(state.buildStatus[state.environment]);
    const latestBuild = state.latestBuild[state.environment];
    const buildMatchesTask = latestBuild?.ref_commit
      ? latestBuild.ref_commit === task.commit_hash
      : !task.commit_hash;
    const isFailed = Boolean(buildMatchesTask && latestBuild?.status === 'failed');
    return `
      <div class="task" data-task-id="${task.id}" ${sessionId ? `data-session-id="${sessionId}"` : ''}>
        <div class="task-header">
          <div class="meta" data-rel-time="${task.created_at || ''}">${formatRelative(task.created_at)}</div>
          <strong class="task-prompt">${task.prompt}</strong>
          <div class="row">
            <div class="badges deploy-status">
              ${isDevelopment ? developmentTaskStateBadge : `
                ${isDeploying ? '<span class="badge building">deploying</span>' : ''}
                ${isLive ? '<span class="badge live">live</span>' : ''}
                ${isFailed && !isDeploying ? '<span class="badge failed">failed</span>' : ''}
              `}
            </div>
            <div class="badges status"> 
              <span class="badge ${badgeClass(task.status)}">${task.status}</span>
            </div>
          </div>
        </div>
        <div class="task-actions">
          ${isDevelopment ? `
            ${renderDevelopmentActionMenu({
              commitHash: task.commit_hash || '',
              taskId: task.id,
              label: 'Task development actions'
            })}
          ` : `
            <button class="icon-button deploy-button" data-commit="${task.commit_hash || ''}" title="Deploy this commit to ${titleCase(state.environment)}" aria-label="Deploy this commit to ${titleCase(state.environment)}">${icon('launch')}</button>
          `}
        </div>
        ${detailState.open ? `
          <div class="task-details">
            <div class="detail-grid">
              <div class="detail-item"><span class="meta">Created</span><span>${task.created_at || '—'}</span></div>
              <div class="detail-item"><span class="meta">Completed</span><span>${task.completed_at || '—'}</span></div>
               ${canDelete ? `<button class="icon-button delete-latest-task" title="Delete latest task" aria-label="Delete latest task">${icon('trash')}</button>` : ''}
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
    const isLive = !isDev && session.merge_commit && session.merge_commit === state.deployedCommit[state.environment] && state.buildStatus[state.environment] === 'live';
    const isDeploying = !isDev && session.merge_commit && session.merge_commit === state.pendingDeployCommit[state.environment] && ['building', 'canceling'].includes(state.buildStatus[state.environment]);
    const detailsState = state.sessionDetails[session.id] || { open: false };
    const latestBuild = state.latestBuild[state.environment];
    const buildMatchesSession = latestBuild?.ref_commit
      ? latestBuild.ref_commit === session.merge_commit
      : false;
    const isFailed = Boolean(buildMatchesSession && latestBuild?.status === 'failed');
    return `
      <div class="session" data-session-id="${session.id}">
        <div class="session-header">
          <div>
            <div class="meta" data-rel-time="${session.created_at || ''}">${formatRelative(session.created_at)}</div>
            <strong>${session.message}</strong>
            ${isDev ? '' : `
              ${isDeploying ? '<span class="badge building">deploying</span>' : ''}
              ${isLive ? '<span class="badge live">live</span>' : ''}
              ${isFailed ? '<span class="badge failed">failed</span>' : ''}
            `}
          </div>
          <div class="task-actions">
            ${isDev ? `
              ${renderDevelopmentActionMenu({
                commitHash: session.merge_commit || '',
                label: 'Saved session development actions'
              })}
            ` : `
              <button class="icon-button deploy-button" data-commit="${session.merge_commit || ''}" title="Deploy this saved session to ${titleCase(state.environment)}" aria-label="Deploy this saved session to ${titleCase(state.environment)}">${icon('launch')}</button>
            `}
          </div>
        </div>
        ${isDev && detailsState.open ? `
          <div class="task-details">
            <div class="detail-grid">
              <div class="detail-item"><span class="meta"></span><span>${formatDate(session.created_at)}</span></div>
            </div> 
            <div class="grid">${tasksHtml}</div>
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
          <h3>${state.confirmTitle || 'Confirm'}</h3>
          <p class="notice">${state.confirmMessage || ''}</p>
          <div class="row">
            ${state.confirmAltText ? `<button class="ghost" id="confirmModalAlt">${state.confirmAltText}</button>` : ''}
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
    const demoOpenAiKeyValue = state.demoOpenAiKeyDraft == null
      ? (state.demoOpenAiKey || '')
      : state.demoOpenAiKeyDraft;
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
          <h3>Deployment</h3>
          <div class="setting-row toggle-row">
            <span class="tag">Verified-only deploys</span>
            <label class="toggle">
              <input id="verifiedOnlyToggle" type="checkbox" ${state.deploymentPolicy?.verifiedOnly ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">Require full verified builds</span>
            </label>
          </div>
          <div class="setting-row setting-info-row">
            <span class="notice">When enabled, development changes wait for a full verified build before showing as live.</span>
            <div class="info-popover">
              <button class="info-icon" type="button" aria-label="Verified-only deploys info" aria-expanded="false">i</button>
              <div class="info-tooltip" role="tooltip">
                Verified-only mode prioritizes release-accurate previews. Fast update previews are skipped so what you see always comes from a complete image build and deploy. This is slower but most reliable.
              </div>
            </div>
          </div>
          ${state.demoMode ? `
          <h3>OpenAI API Key</h3>
          <p class="notice">Used for tasks while demo mode is enabled.</p>
          <div class="setting-row">
            <span class="tag">OpenAI API Key</span>
            <input id="demoOpenAiKey" type="password" placeholder="sk-..." value="${escapeHtml(demoOpenAiKeyValue)}" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" />
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
    this.querySelectorAll('[data-dismiss-toast]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dismissToast(btn.getAttribute('data-dismiss-toast'));
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
      stopAppLogPolling();
      resetTaskProcessingState(null);
      clearAllToasts();
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
        appLogsVisible: false,
        appLogsByEnv: blankEnvMap(''),
        appLogSnapshotByEnv: blankEnvMap(''),
        appLogLoading: blankEnvMap(false),
        appLogError: blankEnvMap(''),
        appLogFrozenByEnv: blankEnvMap(false),
        runtimeQuotaNotice: {},
        authNotice: '',
        createProjectNotice: '',
        projectNotice: ''
      });
    });

    this.querySelector('#openSettings')?.addEventListener('click', async () => {
      setState({
        settingsOpen: true,
        settingsMessage: '',
        demoOpenAiKeyDraft: state.demoOpenAiKey || ''
      });
      await loadHealthSettings();
      await loadDemoSettings();
      await loadDeploymentPolicy();
    });

    this.querySelector('#closeSettings')?.addEventListener('click', () => {
      setState({
        settingsOpen: false,
        demoOpenAiKeyDraft: null
      });
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
      const verifiedOnlyToggle = this.querySelector('#verifiedOnlyToggle');
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
      if (verifiedOnlyToggle) {
        saveCalls.push(
          api('/settings/deployment-policy', {
            method: 'PUT',
            body: JSON.stringify({ verifiedOnly: Boolean(verifiedOnlyToggle.checked) })
          })
        );
      }
      setState({ settingsBusy: true, settingsMessage: 'Saving...' });
      try {
        if (saveCalls.length > 0) {
          await Promise.all(saveCalls);
        }
        if (demoKeyEl) {
          setState({
            demoOpenAiKey: demoKey,
            demoOpenAiKeyDraft: demoKey
          });
        }
        if (verifiedOnlyToggle) {
          setState({
            deploymentPolicy: {
              verifiedOnly: Boolean(verifiedOnlyToggle.checked)
            }
          });
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

    this.querySelector('#demoOpenAiKey')?.addEventListener('input', (event) => {
      state.demoOpenAiKeyDraft = event.target.value;
    });

    const confirmModal = this.querySelector('#confirmModal');
    const closeConfirm = (choice = 'cancel') => {
      if (confirmResolver) confirmResolver(choice);
      confirmResolver = null;
      setState({ confirmOpen: false, confirmAltText: '' });
    };
    this.querySelector('#confirmModalConfirm')?.addEventListener('click', () => closeConfirm('confirm'));
    this.querySelector('#confirmModalAlt')?.addEventListener('click', () => closeConfirm('alt'));
    this.querySelector('#confirmModalCancel')?.addEventListener('click', () => closeConfirm('cancel'));
    confirmModal?.addEventListener('click', (event) => {
      if (event.target === confirmModal) closeConfirm('cancel');
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
      setState({ authNotice: '' });
      try {
        const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        localStorage.setItem('vibes_token', data.token);
        setState({
          token: data.token,
          user: data.user,
          desktopSettings: loadDesktopSettings(data.user?.id),
          authModalOpen: false,
          authNotice: '',
          createProjectNotice: '',
          authErrorMessage: '',
          authErrorCode: '',
          projectNotice: ''
        });
        await loadProjects();
        connectSocket(state.projectId);
      } catch (err) {
        setAuthError(err);
      }
    });

    this.querySelector('#registerBtn')?.addEventListener('click', async () => {
      const email = this.querySelector('#registerEmail').value;
      const password = this.querySelector('#registerPassword').value;
      setState({ authNotice: '' });
      try {
        const data = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
        localStorage.setItem('vibes_token', data.token);
        setState({
          token: data.token,
          user: data.user,
          desktopSettings: loadDesktopSettings(data.user?.id),
          authModalOpen: false,
          authNotice: '',
          createProjectNotice: '',
          authErrorMessage: '',
          authErrorCode: '',
          projectNotice: ''
        });
        await loadProjects();
        connectSocket(state.projectId);
      } catch (err) {
        setAuthError(err);
      }
    });

    ['#loginEmail', '#loginPassword', '#registerEmail', '#registerPassword'].forEach((selector) => {
      this.querySelector(selector)?.addEventListener('input', () => {
        clearAuthError({ render: false });
      });
    });

    const authModal = this.querySelector('.auth-modal');
    if (authModal) {
      this.querySelectorAll('[data-auth-target]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          const mode = btn.getAttribute('data-auth-target') || 'register';
          setState({
            authModalOpen: true,
            authModalMode: mode,
            authNotice: '',
            authErrorMessage: '',
            authErrorCode: ''
          });
        });
      });

      authModal.querySelector('.auth-close')?.addEventListener('click', () => {
        setState({ authModalOpen: false, authNotice: '', authErrorMessage: '', authErrorCode: '' });
      });
      authModal.querySelectorAll('[data-auth-switch]').forEach((btn) => {
        btn.addEventListener('click', () => {
          setState({
            authModalMode: btn.getAttribute('data-auth-switch') || 'register',
            authNotice: '',
            authErrorMessage: '',
            authErrorCode: ''
          });
        });
      });
      authModal.addEventListener('click', (event) => {
        if (event.target === authModal) {
          setState({ authModalOpen: false, authNotice: '', authErrorMessage: '', authErrorCode: '' });
        }
      });
    }

    this.querySelector('#projectSelect')?.addEventListener('change', async (e) => {
      const projectId = e.target.value;
      if (projectId === '__new__') {
        stopAppLogPolling();
        resetTaskProcessingState(null);
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
          appLogsVisible: false,
          appLogsByEnv: blankEnvMap(''),
          appLogSnapshotByEnv: blankEnvMap(''),
          appLogLoading: blankEnvMap(false),
          appLogError: blankEnvMap(''),
          appLogFrozenByEnv: blankEnvMap(false),
          deployWebhookUrl: '',
          deployWebhookMessage: '',
          createProjectNotice: '',
          projectNotice: ''
        });
        localStorage.setItem('vibes_nerd_level', 'beginner');
        const key = projectStorageKey(state.user?.id);
        if (key) localStorage.removeItem(key);
        return;
      }
      const storedEnv = loadStoredEnv(state.user?.id, projectId);
      storeProject(state.user?.id, projectId);
      stopAppLogPolling();
      resetTaskProcessingState(projectId);
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
        appLogsByEnv: blankEnvMap(''),
        appLogSnapshotByEnv: blankEnvMap(''),
        appLogLoading: blankEnvMap(false),
        appLogError: blankEnvMap(''),
        appLogFrozenByEnv: blankEnvMap(false),
        deployWebhookMessage: '',
        createProjectNotice: '',
        projectNotice: '',
        database: createDatabaseState()
      });
      await loadTasks(projectId);
      await loadSessions(projectId);
      await loadEnvVars(projectId, state.environment);
      await loadLatestBuild(projectId, state.environment);
      await loadLastSuccessBuilds(projectId);
      await loadDeployWebhook(projectId);
      setDatabaseState(resetDatabaseStateForProject());
      await loadDatabaseCatalog(projectId, state.environment);
      connectSocket(projectId);
      if (DESKTOP_BRIDGE && projectId) {
        // repo sync happens only when running mobile simulators
      }
    });

    this.querySelector('#createProjectBtn')?.addEventListener('click', async () => {
      const name = this.querySelector('#createProjectName')?.value?.trim();
      if (!name) return setInlineNotice('createProjectNotice', 'Enter a project name');
      if (name.length > 30) {
        return setInlineNotice('createProjectNotice', 'Project name must be 30 characters or fewer');
      }
      if (isProjectNameTaken(name)) return setInlineNotice('createProjectNotice', 'Project name already exists');
      try {
        setState({ createProjectNotice: '' });
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
        stopAppLogPolling();
        resetTaskProcessingState(project.id);
        setState({
          projectId: project.id,
          environment: 'development',
          nerdLevel: 'beginner',
          createProjectName: '',
          createProjectNotice: '',
          projectNotice: '',
          appLogsByEnv: blankEnvMap(''),
          appLogSnapshotByEnv: blankEnvMap(''),
          appLogLoading: blankEnvMap(false),
          appLogError: blankEnvMap(''),
          appLogFrozenByEnv: blankEnvMap(false)
        });
        localStorage.setItem('vibes_nerd_level', 'beginner');
        connectSocket(project.id);
        if (DESKTOP_BRIDGE && project.id) {
          // repo sync happens only when running mobile simulators
        }
      } catch (err) {
        if (String(err.message || '').toLowerCase().includes('already exists')) {
          setInlineNotice('createProjectNotice', 'Project name already exists. Please choose another.');
          return;
        }
        showError(err, { noticeField: 'createProjectNotice' });
      }
    });

    this.querySelector('#createProjectName')?.addEventListener('input', (event) => {
      state.createProjectName = event.target.value || '';
      if (state.createProjectNotice) setState({ createProjectNotice: '' });
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
      if (
        e.target.closest('button') ||
        e.target.closest('pre') ||
        e.target.closest('a') ||
        e.target.closest('input') ||
        e.target.closest('textarea') ||
        e.target.closest('select') ||
        e.target.closest('.task-action-menu') ||
        e.target.closest('summary')
      ) {
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
          stopAppLogPolling();
          resetTaskProcessingState(null);
          setState({
            tasks: [],
            sessions: [],
            envVars: {},
            buildStatus: { development: 'offline', testing: 'offline', production: 'offline' },
            deployedCommit: { development: '', testing: '', production: '' },
            pendingDeployCommit: { development: '', testing: '', production: '' },
            progressVisibleUntil: { development: 0, testing: 0, production: 0 },
            updatedAt: { development: '', testing: '', production: '' },
            appLogsVisible: false,
            appLogsByEnv: blankEnvMap(''),
            appLogSnapshotByEnv: blankEnvMap(''),
            appLogLoading: blankEnvMap(false),
          appLogError: blankEnvMap(''),
          appLogFrozenByEnv: blankEnvMap(false),
          environment: 'development',
          nerdLevel: 'beginner',
          createProjectNotice: '',
          projectNotice: ''
        });
          return;
        }
        const storedEnv = loadStoredEnv(state.user?.id, nextProjectId);
        resetTaskProcessingState(nextProjectId);
        setState({ environment: storedEnv || state.environment, projectNotice: '' });
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
      if (!name) {
        pushToast({ message: 'Enter a project name', tone: 'warning', dedupeKey: 'project-rename:empty' });
        return;
      }
      if (isProjectNameTaken(name, project.id)) {
        pushToast({ message: 'Project name already exists', tone: 'warning', dedupeKey: 'project-rename:duplicate' });
        return;
      }
      try {
        await api(`/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
        await loadProjects();
      } catch (err) {
        if (String(err.message || '').toLowerCase().includes('already exists')) {
          pushToast({ message: 'Project name already exists. Please choose another.', tone: 'warning', dedupeKey: 'project-rename:duplicate' });
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
        setState({ environment: env, taskSubmissionPending: null, projectNotice: '' });
        storeEnv(state.user?.id, state.projectId, env);
        if (env === 'development') {
          setTaskProcessingHydration(state.projectId, { buildLoaded: false });
        }
        if (state.projectId) {
          loadEnvVars(state.projectId, env);
          loadLatestBuild(state.projectId, env);
          loadDatabaseCatalog(state.projectId, env);
          if (state.appLogsVisible && !state.appLogFrozenByEnv[env]) {
            fetchApplicationLogs({ force: true });
          } else if (state.appLogsVisible) {
            updateAppLogPanel();
          }
          ensureAppLogPolling();
        }
      });
    });

    const selectEnvironmentFromPill = (btn) => {
      const env = btn.getAttribute('data-env');
      if (!env) return;
      closeEnvActionMenus(this);
      closeTaskActionMenus(this);
      setState({
        environment: env,
        envEditing: { ...state.envEditing, [env]: false },
        envMessage: '',
        taskSubmissionPending: null,
        projectNotice: ''
      });
      storeEnv(state.user?.id, state.projectId, env);
      if (env === 'development') {
        setTaskProcessingHydration(state.projectId, { buildLoaded: false });
      }
      if (state.projectId) {
        loadEnvVars(state.projectId, env);
        loadLatestBuild(state.projectId, env);
        loadDatabaseCatalog(state.projectId, env);
        if (state.appLogsVisible && !state.appLogFrozenByEnv[env]) {
          fetchApplicationLogs({ force: true });
        } else if (state.appLogsVisible) {
          updateAppLogPanel();
        }
        ensureAppLogPolling();
      }
    };

    this.querySelectorAll('.env-pill').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.env-pill-action, .env-pill-menu, .env-menu-item, .menu')) return;
        selectEnvironmentFromPill(btn);
      });
      btn.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target instanceof Element && event.target.closest('.env-pill-action, .env-pill-menu, .env-menu-item, .menu')) return;
        event.preventDefault();
        selectEnvironmentFromPill(btn);
      });
    });

    const patchCurrentEnvironmentState = (env, patch = {}) => {
      const nextProjects = state.projects.map((project) => {
        if (project.id !== state.projectId) return project;
        return {
          ...project,
          environments: {
            ...(project.environments || {}),
            [env]: {
              ...(project.environments?.[env] || {}),
              ...patch
            }
          }
        };
      });
      setState({ projects: nextProjects });
    };

    const patchDevelopmentState = (patch = {}) => {
      patchCurrentEnvironmentState('development', patch);
    };

    const currentDevelopmentUrl = () => {
      const project = currentProjectState();
      return project ? `${projectProtocol()}://${projectUrl(project, 'development')}` : '';
    };

    const openDevelopment = async () => {
      const url = currentDevelopmentUrl();
      if (!url) return;
      await openExternalLink(url);
    };

    const saveDevelopmentSelection = async ({ mode, taskId, commitHash } = {}) => {
      const body = {};
      const modeKey = mode ? normalizeDevelopmentModeValue(mode) : null;
      if (modeKey) body.mode = modeKey;
      if (taskId !== undefined) body.taskId = taskId || null;
      if (commitHash !== undefined) body.commitHash = commitHash || null;
      const response = await api(`/projects/${state.projectId}/development/selection`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      patchDevelopmentState({
        ...(modeKey ? { selected_mode: modeKey } : {}),
        ...(taskId !== undefined ? { selected_task_id: taskId || null } : {}),
        ...(commitHash !== undefined ? { selected_commit_sha: commitHash || null } : {})
      });
      return response;
    };

    const wakeDevelopment = async ({ mode, taskId, commitHash } = {}) => {
      const envState = projectEnvironmentState(state.projectId, 'development') || {};
      const wasAwake = isDevelopmentAwake(envState);
      const modeKey = normalizeDevelopmentModeValue(mode || envState.selected_mode || envState.preview_mode || 'verified');
      const modeLabel = developmentModeText(modeKey);
      patchDevelopmentState({
        ...(mode !== undefined ? { selected_mode: modeKey } : {}),
        ...(taskId !== undefined ? { selected_task_id: taskId || null } : {}),
        ...(commitHash !== undefined ? { selected_commit_sha: commitHash || null } : {}),
        preview_mode: modeKey,
        workspace_state: 'starting',
        live_task_id: null,
        live_commit_sha: null,
        ...(modeKey === 'verified' ? { build_status: 'building' } : {})
      });
      const body = {};
      if (mode !== undefined) body.mode = modeKey;
      if (taskId !== undefined) body.taskId = taskId || null;
      if (commitHash !== undefined) body.commitHash = commitHash || null;
      const response = await api(`/projects/${state.projectId}/development/wake`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (response?.status === 'already_live') {
        pushToast({ message: `${modeLabel} is already live`, tone: 'info', dedupeKey: `env-action:${state.projectId}:development:already-live:${modeKey}` });
      } else if (response?.status === 'already_starting') {
        pushToast({ message: `Development is already starting in ${modeLabel}`, tone: 'info', dedupeKey: `env-action:${state.projectId}:development:already-starting:${modeKey}` });
      } else {
        pushToast({
          message: `${wasAwake ? 'Switching Development to' : 'Waking Development in'} ${modeLabel}`,
          tone: 'info',
          dedupeKey: `env-action:${state.projectId}:development:wake:${modeKey}`
        });
      }
      return response;
    };

    const runDevelopmentTaskAction = async (mode, commitHash, taskId) => {
      if (!commitHash) {
        pushToast({ message: 'No commit hash available', tone: 'warning', dedupeKey: 'task-action:missing-commit' });
        return;
      }
      const modeLabel = developmentModeText(mode);
      closeTaskActionMenus(this);
      try {
        await wakeDevelopment({
          mode,
          taskId: taskId || null,
          commitHash
        });
        pushToast({ message: `Starting ${modeLabel}`, tone: 'info', dedupeKey: `env-action:${state.projectId}:development:start:${mode}:${commitHash}` });
      } catch (err) {
        showError(err);
        loadProjects();
      }
    };

    const runEnvironmentAction = async (env, action) => {
      if (!state.projectId || !env) return;
      closeEnvActionMenus(this);
      if (action === 'open-development') {
        await openDevelopment();
        return;
      }
      if (env === 'development' && (action === 'select-preview' || action === 'select-full-build')) {
      const project = currentProjectState();
      const envState = projectEnvironmentState(project, env);
      const modeKey = action === 'select-preview' ? 'workspace' : 'verified';
      const modeLabel = developmentModeText(modeKey);
      setState({ projectNotice: '' });
      if (state.deploymentPolicy?.verifiedOnly && modeKey === 'workspace') {
          pushToast({ message: 'Preview Mode is disabled by verified-only deploys', tone: 'warning', dedupeKey: 'env-action:development:verified-only' });
          return;
        }
        if (developmentSelectedMode(project) === modeKey) return;
        if (!isDevelopmentAwake(envState)) {
          try {
            await saveDevelopmentSelection({ mode: modeKey });
            pushToast({ message: `${modeLabel} selected`, tone: 'info', dedupeKey: `env-action:${state.projectId}:development:select:${modeKey}` });
          } catch (err) {
            showError(err);
          }
          return;
        }
        const choice = await showConfirmChoices(
          `This will stop the currently running Development environment and switch to ${modeLabel}.`,
          {
            title: 'Switch Development Mode?',
            confirmText: 'Confirm',
            altText: 'Confirm and Wake',
            cancelText: 'Cancel'
          }
        );
        if (choice === 'cancel') return;
        try {
          await saveDevelopmentSelection({ mode: modeKey });
          if (choice === 'alt') {
            await wakeDevelopment({ mode: modeKey });
          } else {
            await api(`/projects/${state.projectId}/stop`, {
              method: 'POST',
              body: JSON.stringify({ environment: env })
            });
            patchDevelopmentState({
              build_status: 'offline',
              workspace_state: 'sleeping',
              live_task_id: null,
              live_commit_sha: null
            });
            pushToast({ message: `${modeLabel} selected`, tone: 'info', dedupeKey: `env-action:${state.projectId}:development:select:${modeKey}` });
          }
        } catch (err) {
          showError(err);
          loadProjects();
        }
        return;
      }
      if (env === 'development' && action === 'wake-development') {
        try {
          setState({ projectNotice: '' });
          const selectedMode = developmentSelectedMode(currentProjectState());
          await wakeDevelopment({ mode: selectedMode });
        } catch (err) {
          showError(err);
          loadProjects();
        }
        return;
      }
      if (env === 'development' && action === 'sleep-development') {
        const ok = await showConfirm('Sleep Development?', { confirmText: 'Sleep' });
        if (!ok) return;
        setState({ projectNotice: '' });
        pushToast({ message: 'Sleeping Development...', tone: 'info', dedupeKey: `env-action:${state.projectId}:development:sleep` });
        try {
          await api(`/projects/${state.projectId}/stop`, {
            method: 'POST',
            body: JSON.stringify({ environment: env })
          });
          patchDevelopmentState({
            build_status: 'offline',
            workspace_state: 'sleeping',
            live_task_id: null,
            live_commit_sha: null
          });
        } catch (err) {
          showError(err);
        }
        return;
      }
      if (action === 'cancel') {
        setState({ projectNotice: '' });
        if (state.buildStatus[env] === 'canceling') {
          pushToast({ message: 'Build cancel is already in progress.', tone: 'info', dedupeKey: `env-action:${state.projectId}:${env}:cancel-pending` });
          return;
        }
        pushToast({ message: 'Canceling build...', tone: 'info', dedupeKey: `env-action:${state.projectId}:${env}:cancel` });
        state.buildStatus[env] = 'canceling';
        setState({ buildStatus: { ...state.buildStatus } });
        try {
          await api(`/projects/${state.projectId}/builds/cancel`, {
            method: 'POST',
            body: JSON.stringify({ environment: env })
          });
        } catch (err) {
          showError(err);
        } finally {
          await loadLatestBuild(state.projectId, env);
          ensureBuildLogPolling();
        }
        return;
      }
      if (action === 'stop') {
        const ok = await showConfirm(`Stop the ${titleCase(env)} environment?`, { confirmText: 'Stop' });
        if (!ok) return;
        setState({ projectNotice: '' });
        pushToast({ message: 'Stopping environment...', tone: 'info', dedupeKey: `env-action:${state.projectId}:${env}:stop` });
        try {
          await api(`/projects/${state.projectId}/stop`, {
            method: 'POST',
            body: JSON.stringify({ environment: env })
          });
          await loadLatestBuild(state.projectId, env);
        } catch (err) {
          showError(err);
        }
      }
    };

    this.querySelectorAll('.env-pill-action[data-action]').forEach((control) => {
      control.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const env = control.getAttribute('data-env');
        const action = control.getAttribute('data-action');
        if (!env || !action) return;
        await runEnvironmentAction(env, action);
      });
    });

    this.querySelectorAll('.env-menu-item').forEach((control) => {
      control.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (control.disabled) return;
        const env = control.getAttribute('data-env');
        const action = control.getAttribute('data-action');
        if (!env || !action) return;
        await runEnvironmentAction(env, action);
      });
    });

    this.querySelectorAll('.env-mode-toggle-input').forEach((control) => {
      control.addEventListener('change', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (control.disabled) return;
        const env = control.getAttribute('data-env');
        const mode = normalizeDevelopmentModeValue(control.getAttribute('data-mode'));
        if (!env || env !== 'development') return;
        const nextMode = control.checked ? mode : (mode === 'workspace' ? 'verified' : 'workspace');
        const action = nextMode === 'workspace' ? 'select-preview' : 'select-full-build';
        await runEnvironmentAction(env, action);
      });
    });

    this.querySelectorAll('.env-pill-menu summary').forEach((summary) => {
      summary.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    });

    this.querySelectorAll('.task-action-menu summary').forEach((summary) => {
      summary.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    });

    this.querySelectorAll('.task-menu-item').forEach((control) => {
      control.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = control.getAttribute('data-task-action');
        const commitHash = control.getAttribute('data-commit') || '';
        const taskId = control.getAttribute('data-task-id') || null;
        if (action === 'start-preview') {
          await runDevelopmentTaskAction('workspace', commitHash, taskId);
          return;
        }
        if (action === 'start-full-build') {
          await runDevelopmentTaskAction('verified', commitHash, taskId);
        }
      });
    });

    if (!this._envMenuBound) {
      this._envMenuBound = true;
      document.addEventListener('click', (event) => {
        if (!this.isConnected) return;
        if (event.target instanceof Element && event.target.closest('.env-pill-menu')) return;
        closeEnvActionMenus(this);
        closeTaskActionMenus(this);
      });
    }

    this.querySelector('#nerdLevel')?.addEventListener('change', (e) => {
      const level = e.target.value;
      localStorage.setItem('vibes_nerd_level', level);
      if (level === 'beginner' && state.environment !== 'development') {
        setState({
          nerdLevel: level,
          environment: 'development',
          envEditing: { ...state.envEditing, development: false },
          envMessage: '',
          taskSubmissionPending: null
        });
        storeEnv(state.user?.id, state.projectId, 'development');
        if (state.projectId) {
          setTaskProcessingHydration(state.projectId, { buildLoaded: false });
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
      if (!prompt) {
        pushToast({ message: 'Enter a task prompt', tone: 'warning', dedupeKey: 'task-submit:empty' });
        return;
      }
      const submitEnv = state.environment;
      setState({ projectNotice: '' });
      prepareAppLogsForDeploy(submitEnv);
      if (state.appLogsVisible) {
        // Keep the panel cleared while waiting for the next build to start.
        stopAppLogPolling();
        updateAppLogPanel({ forceScroll: true });
      }
      setState({
        taskSubmissionPending: {
          projectId: state.projectId,
          environment: submitEnv,
          createdAt: Date.now()
        }
      });
      try {
        const task = await api(`/projects/${state.projectId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({ prompt, environment: state.environment })
        });
        setState({ tasks: [task, ...state.tasks], taskPromptDraft: '', taskSubmissionPending: null });
        this.querySelector('#taskPrompt').value = '';
      } catch (err) {
        setState({ taskSubmissionPending: null });
        showError(err);
      }
    });

    this.querySelector('#toggleAppLogs')?.addEventListener('change', async (event) => {
      const enabled = Boolean(event.target?.checked);
      setState({ appLogsVisible: enabled });
      if (enabled) {
        if (state.appLogFrozenByEnv[state.environment]) {
          updateAppLogPanel({ forceScroll: true });
        } else {
          await fetchApplicationLogs({ force: true });
        }
      }
      ensureAppLogPolling();
    });

    this.querySelector('#copyAppLogs')?.addEventListener('click', async () => {
      const text = state.appLogsByEnv[state.environment] || '';
      if (!text) {
        pushToast({ message: 'No application logs to copy yet.', tone: 'warning', dedupeKey: `copy-app-logs:${state.projectId}:${state.environment}:empty` });
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        pushToast({ message: 'Copied application logs', tone: 'success', dedupeKey: `copy-app-logs:${state.projectId}:${state.environment}` });
      } catch {
        const temp = document.createElement('textarea');
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
        pushToast({ message: 'Copied application logs', tone: 'success', dedupeKey: `copy-app-logs:${state.projectId}:${state.environment}` });
      }
    });

    this.querySelector('#toggleVerifyLogs')?.addEventListener('click', async () => {
      const env = state.environment;
      const nextVisible = !state.failedBuildLogVisible[env];
      if (!nextVisible) {
        state.failedBuildLogVisible[env] = false;
        setState({ failedBuildLogVisible: { ...state.failedBuildLogVisible } });
        return;
      }
      state.failedBuildLogVisible[env] = true;
      setState({ failedBuildLogVisible: { ...state.failedBuildLogVisible } });
      const latestBuild = state.latestBuild[env];
      if (!state.failedBuildLog[env] && !state.failedBuildLogLoading[env]) {
        await loadBuildLog(env, {
          status: 'failed',
          commitHash: latestBuild?.ref_commit || ''
        });
      }
    });

    this.querySelector('#copyVerifyLogs')?.addEventListener('click', async () => {
      const text = state.failedBuildLog[state.environment] || '';
      if (!text) {
        pushToast({ message: 'No full build logs to copy yet.', tone: 'warning', dedupeKey: `copy-verify-logs:${state.projectId}:${state.environment}:empty` });
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        pushToast({ message: 'Copied full build logs', tone: 'success', dedupeKey: `copy-verify-logs:${state.projectId}:${state.environment}` });
      } catch {
        const temp = document.createElement('textarea');
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
        pushToast({ message: 'Copied full build logs', tone: 'success', dedupeKey: `copy-verify-logs:${state.projectId}:${state.environment}` });
      }
    });

    this.querySelector('#saveSession')?.addEventListener('click', () => {
      const canSaveSession = state.tasks.some((t) => t.environment === 'development' && !t.session_id);
      if (!canSaveSession) {
        pushToast({ message: 'Add at least one task before saving a session.', tone: 'warning', dedupeKey: 'save-session:empty' });
        return;
      }
      this.querySelector('#saveModal').classList.add('open');
    });

    this.querySelector('#cancelSave')?.addEventListener('click', () => {
      this.querySelector('#saveModal').classList.remove('open');
    });

    this.querySelector('#confirmSave')?.addEventListener('click', async () => {
      const message = this.querySelector('#saveMessage').value;
      if (!message) {
        pushToast({ message: 'Enter a message', tone: 'warning', dedupeKey: 'save-session:missing-message' });
        return;
      }
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
          const disposition = res.headers.get('content-disposition') || '';
          const match = disposition.match(/filename="?([^"]+)"?/i);
          return res.blob().then((blob) => ({
            blob,
            filename: match?.[1] || `${state.projects.find((p) => p.id === state.projectId)?.name || 'project'}.bundle`
          }));
        })
        .then(({ blob, filename }) => {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = filename;
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

    this.querySelector('#refreshDatabase')?.addEventListener('click', async () => {
      await loadDatabaseCatalog(state.projectId, state.environment, { force: true });
    });

    this.querySelectorAll('[data-db-select="true"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const schema = button.getAttribute('data-schema') || '';
        const object = button.getAttribute('data-object') || '';
        const type = button.getAttribute('data-type') || '';
        const env = state.environment;
        const selected = {
          ...state.database.selected,
          [env]: {
            ...state.database.selected[env],
            schema,
            object,
            type
          }
        };
        const controls = {
          ...state.database.controls,
          [env]: {
            ...databaseControls(env),
            sortColumn: state.database.objectDetails[env]?.primaryKey?.[0] || ''
          }
        };
        setDatabaseState({ selected, controls });
        await loadDatabaseObject(state.projectId, env, schema, object);
        await loadDatabaseRows(state.projectId, env);
      });
    });

    this.querySelectorAll('[data-db-tab]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tab = button.getAttribute('data-db-tab') || 'browse';
        const env = state.environment;
        setDatabaseState({
          selected: {
            ...state.database.selected,
            [env]: {
              ...state.database.selected[env],
              tab
            }
          }
        });
        if (tab === 'history') {
          await loadDatabaseHistory(state.projectId, env);
        }
      });
    });

    this.querySelector('#applyDbBrowse')?.addEventListener('click', async () => {
      const env = state.environment;
      const nextControls = {
        ...databaseControls(env),
        page: 1,
        pageSize: Number(this.querySelector('#dbPageSize')?.value || DEFAULT_DATABASE_PAGE_SIZE),
        filterColumn: this.querySelector('#dbFilterColumn')?.value || '',
        filterValue: this.querySelector('#dbFilterValue')?.value || '',
        sortColumn: this.querySelector('#dbSortColumn')?.value || '',
        sortDirection: this.querySelector('#dbSortDirection')?.value || 'asc'
      };
      setDatabaseState({
        controls: {
          ...state.database.controls,
          [env]: nextControls
        }
      });
      await loadDatabaseRows(state.projectId, env);
    });

    this.querySelector('#dbPrevPage')?.addEventListener('click', async () => {
      const env = state.environment;
      const nextControls = {
        ...databaseControls(env),
        page: Math.max(1, Number(databaseControls(env).page || 1) - 1)
      };
      setDatabaseState({
        controls: {
          ...state.database.controls,
          [env]: nextControls
        }
      });
      await loadDatabaseRows(state.projectId, env);
    });

    this.querySelector('#dbNextPage')?.addEventListener('click', async () => {
      const env = state.environment;
      const nextControls = {
        ...databaseControls(env),
        page: Number(databaseControls(env).page || 1) + 1
      };
      setDatabaseState({
        controls: {
          ...state.database.controls,
          [env]: nextControls
        }
      });
      await loadDatabaseRows(state.projectId, env);
    });

    this.querySelector('#dbSqlEditor')?.addEventListener('input', (event) => {
      const env = state.environment;
      const sqlDraft = {
        ...state.database.sqlDraft,
        [env]: event.target.value
      };
      storeDatabaseSql(state.user?.id, state.projectId, env, event.target.value);
      setDatabaseState({ sqlDraft });
    });

    this.querySelector('#runDbQuery')?.addEventListener('click', async () => {
      await runDatabaseQuery(state.projectId, state.environment);
    });

    this.querySelector('#emptyDb')?.addEventListener('click', async () => {
      const confirmation = await showPrompt(
        `Type ${state.environment.toUpperCase()} to confirm wiping the ${state.environment} database.`,
        {
          placeholder: state.environment.toUpperCase(),
          confirmText: 'Empty Database',
          initialValue: ''
        }
      );
      if (confirmation !== state.environment.toUpperCase()) {
        setDatabaseState({ notice: 'Database reset cancelled.' });
        return;
      }
      api(`/projects/${state.projectId}/env/${state.environment}/empty-db`, { method: 'POST' })
        .then(() => setDatabaseState({ notice: 'Database reset queued. Refresh after the worker completes the reset.' }))
        .catch((err) => setDatabaseState({ notice: err.message || 'Database reset failed.' }));
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
        if (!commitHash) {
          pushToast({ message: 'No commit hash available', tone: 'warning', dedupeKey: 'deploy:missing-commit' });
          return;
        }
        setState({ projectNotice: '' });
        prepareAppLogsForDeploy(state.environment);
        if (state.appLogsVisible) {
          fetchApplicationLogs({ force: true });
          ensureAppLogPolling();
        }
        try {
          const response = await api(`/projects/${state.projectId}/deploy`, {
            method: 'POST',
            body: JSON.stringify({ commitHash, environment: state.environment })
          });
          if (response?.status === 'already_live') {
            state.pendingDeployCommit[state.environment] = '';
            setState({
              pendingDeployCommit: { ...state.pendingDeployCommit }
            });
            pushToast({ message: 'This commit is already live', tone: 'info', dedupeKey: `deploy:${state.projectId}:${state.environment}:${commitHash}:already-live` });
            return;
          }
          if (response?.status === 'already_building') {
            state.pendingDeployCommit[state.environment] = commitHash;
            setState({
              pendingDeployCommit: { ...state.pendingDeployCommit }
            });
            pushToast({ message: 'A deploy for this commit is already in progress', tone: 'info', dedupeKey: `deploy:${state.projectId}:${state.environment}:${commitHash}:already-building` });
            return;
          }
          state.pendingDeployCommit[state.environment] = commitHash;
          state.buildStatus[state.environment] = 'building';
          state.progressVisibleUntil[state.environment] = 0;
          setState({
            pendingDeployCommit: { ...state.pendingDeployCommit },
            buildStatus: { ...state.buildStatus },
            progressVisibleUntil: { ...state.progressVisibleUntil }
          });
        } catch (err) {
          state.pendingDeployCommit[state.environment] = '';
          setState({
            pendingDeployCommit: { ...state.pendingDeployCommit }
          });
          showError(err);
        }
      });
    });

    this.querySelectorAll('.copy-task').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const block = btn.closest('.detail-block');
        const pre = block?.querySelector('pre');
        const text = pre?.textContent || '';
        if (!text) {
          pushToast({ message: 'Nothing to copy', tone: 'warning', dedupeKey: 'copy-task:empty' });
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          pushToast({ message: 'Copied', tone: 'success', dedupeKey: 'copy-task:success' });
        } catch {
          const temp = document.createElement('textarea');
          temp.value = text;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          temp.remove();
          pushToast({ message: 'Copied', tone: 'success', dedupeKey: 'copy-task:success' });
        }
      });
    });

    ensureAppLogPolling();
    updateAppLogPanel();
  }
}

customElements.define('app-shell', AppShell);

if (state.token) {
  if (!state.user) {
    const tokenUser = userFromToken(state.token);
    if (tokenUser) setState({ user: tokenUser, desktopSettings: loadDesktopSettings(tokenUser?.id) });
  }
  loadCurrentUser().finally(() => {
    if (state.token) loadProjects();
  });
}
