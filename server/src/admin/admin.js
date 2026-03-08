const loginSection = document.getElementById('loginSection');
const dashboardSection = document.getElementById('dashboardSection');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusBadge = document.getElementById('statusBadge');
const metricsExportJson = document.getElementById('metricsExportJson');
const metricsExportCsv = document.getElementById('metricsExportCsv');
const metricsSummary = document.getElementById('metricsSummary');
const metricsMeta = document.getElementById('metricsMeta');

const capacitySummary = document.getElementById('capacitySummary');
const podSummary = document.getElementById('podSummary');
const crashLoopList = document.getElementById('crashLoopList');
const nodegroupTable = document.getElementById('nodegroupTable');
const namespaceTable = document.getElementById('namespaceTable');
const projectSummary = document.getElementById('projectSummary');
const auditLog = document.getElementById('auditLog');
const auditCard = document.getElementById('auditCard');
const auditToggle = document.getElementById('auditToggle');
const auditExport = document.getElementById('auditExport');
const auditSearch = document.getElementById('auditSearch');
const auditAction = document.getElementById('auditAction');
const auditSince = document.getElementById('auditSince');
const auditLimit = document.getElementById('auditLimit');
const auditApply = document.getElementById('auditApply');
const auditClear = document.getElementById('auditClear');
const alertsList = document.getElementById('alertsList');
const alertsRefresh = document.getElementById('alertsRefresh');
const alertsToggle = document.getElementById('alertsToggle');
const queueSummary = document.getElementById('queueSummary');
const queueNotice = document.getElementById('queueNotice');
const alertsExport = document.getElementById('alertsExport');
const alertsSearch = document.getElementById('alertsSearch');
const alertsType = document.getElementById('alertsType');
const alertsLevel = document.getElementById('alertsLevel');
const alertsApply = document.getElementById('alertsApply');
const alertsClear = document.getElementById('alertsClear');
const cpuSpark = document.getElementById('cpuSpark');
const memSpark = document.getElementById('memSpark');

const STORAGE_KEY = 'vibes_admin_token';
const HISTORY_KEY = 'vibes_admin_metrics_history';
let lastAuditRows = [];
let lastMetrics = null;
let lastAlerts = [];
let showAcknowledgedAlerts = false;
const alertFilters = {
  search: '',
  type: '',
  level: ''
};
const auditFilters = {
  search: '',
  action: '',
  since: '',
  limit: 50
};

function setStatus(text, isError = false) {
  statusBadge.textContent = text;
  statusBadge.classList.toggle('is-error', Boolean(isError));
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function applyMetaStatus(meta) {
  if (!meta) return setStatus('Updated');
  const age = meta.generated_at ? formatAge(Date.now() - meta.generated_at) : '';
  if (meta.stale) {
    const label = age ? `Stale (${age})` : 'Stale';
    return setStatus(label, true);
  }
  if (meta.cached) {
    const label = age ? `Cached (${age})` : 'Cached';
    return setStatus(label);
  }
  return setStatus('Updated');
}

function formatTimestamp(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'n/a';
  return date.toLocaleString();
}

function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'n/a';
  return `${num}%`;
}

function buildMetricsSummary(metrics) {
  const totals = metrics.nodes?.totals || {};
  const podTotals = metrics.pods?.totals || {};
  const podTotalCount = Object.values(podTotals).reduce((sum, value) => sum + Number(value || 0), 0);
  const envs = metrics.projects?.environments || {};
  return [
    { label: 'Nodes', value: totals.nodes ?? 0 },
    { label: 'Nodegroups', value: metrics.nodes?.by_nodegroup?.length ?? 0 },
    { label: 'Pods', value: podTotalCount },
    { label: 'CrashLoop', value: metrics.pods?.issues?.crash_loop ?? 0 },
    { label: 'Pending', value: podTotals.Pending ?? 0 },
    { label: 'CPU %', value: formatPercent(metrics.capacity?.cpu_percent) },
    { label: 'Mem %', value: formatPercent(metrics.capacity?.mem_percent) },
    { label: 'Projects', value: metrics.projects?.total ?? 0 },
    { label: 'Dev Live', value: envs.development?.live ?? 0 },
    { label: 'Test Live', value: envs.testing?.live ?? 0 },
    { label: 'Prod Live', value: envs.production?.live ?? 0 }
  ];
}

function summaryToObject(summary) {
  return summary.reduce((acc, item) => {
    acc[item.label] = item.value;
    return acc;
  }, {});
}

function renderMetricsSummary(metrics) {
  if (!metricsSummary) return;
  metricsSummary.innerHTML = '';
  const summary = buildMetricsSummary(metrics);
  summary.forEach(({ label, value }) => {
    const chip = document.createElement('div');
    chip.className = 'metric-chip';
    chip.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    metricsSummary.appendChild(chip);
  });
}

function renderMetricsMeta(meta, health) {
  if (!metricsMeta) return;
  metricsMeta.innerHTML = '';
  const items = [];
  if (meta?.last_success_at) {
    items.push({ text: `Last successful refresh: ${formatTimestamp(meta.last_success_at)}` });
  }
  if (meta?.stale) {
    items.push({ text: 'Showing cached metrics (stale).', warn: true });
  } else if (meta?.cached) {
    items.push({ text: 'Showing cached metrics.', warn: false });
  }
  if (meta?.error) {
    items.push({ text: `kubectl error: ${meta.error}`, warn: true });
  }
  if (health) {
    if (health.ok) {
      const latency = Number.isFinite(health.latency_ms) ? `${health.latency_ms}ms` : 'ok';
      items.push({ text: `kubectl health: OK (${latency})` });
    } else {
      items.push({ text: `kubectl health: unavailable`, warn: true });
    }
  }
  if (!items.length) return;
  items.forEach((item, index) => {
    const span = document.createElement('span');
    span.textContent = item.text;
    if (item.warn) span.classList.add('warn');
    metricsMeta.appendChild(span);
    if (index < items.length - 1) {
      const dot = document.createElement('span');
      dot.textContent = '•';
      metricsMeta.appendChild(dot);
    }
  });
}

function readAuditFilters() {
  auditFilters.search = (auditSearch?.value || '').trim();
  auditFilters.action = (auditAction?.value || '').trim();
  auditFilters.limit = Number(auditLimit?.value || 50) || 50;
  const sinceValue = auditSince?.value || '';
  if (sinceValue) {
    const parsed = new Date(sinceValue);
    auditFilters.since = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  } else {
    auditFilters.since = '';
  }
}

function syncAuditInputs() {
  if (auditSearch) auditSearch.value = auditFilters.search;
  if (auditAction) auditAction.value = auditFilters.action;
  if (auditLimit) auditLimit.value = String(auditFilters.limit);
  if (auditSince) {
    if (!auditFilters.since) {
      auditSince.value = '';
    } else {
      const date = new Date(auditFilters.since);
      if (Number.isFinite(date.getTime())) {
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
        auditSince.value = local;
      }
    }
  }
}

function buildAuditQuery() {
  const params = new URLSearchParams();
  params.set('limit', String(auditFilters.limit || 50));
  if (auditFilters.action) params.set('action', auditFilters.action);
  if (auditFilters.since) params.set('since', auditFilters.since);
  return params.toString();
}

function filterAuditRows(rows) {
  const query = auditFilters.search.toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => {
    const meta = row.meta ? JSON.stringify(row.meta) : '';
    const haystack = [
      row.action,
      row.admin_key_fingerprint,
      row.ip,
      row.user_agent,
      row.path,
      row.method,
      meta
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function metricsToCsv(metrics, exportMeta = {}) {
  const lines = [];
  const push = (row) => lines.push(row.map(escapeCsv).join(','));

  push(['section', 'field', 'value']);
  if (exportMeta.exported_at) {
    push(['export', 'exported_at', exportMeta.exported_at]);
  }
  push(['meta', 'generated_at', metrics.generated_at || '']);
  if (metrics.meta) {
    push(['meta', 'cached', metrics.meta.cached ? 'true' : 'false']);
    push(['meta', 'stale', metrics.meta.stale ? 'true' : 'false']);
    if (metrics.meta.age_ms != null) push(['meta', 'age_ms', metrics.meta.age_ms]);
    if (metrics.meta.last_success_at) push(['meta', 'last_success_at', metrics.meta.last_success_at]);
    if (metrics.meta.last_error_at) push(['meta', 'last_error_at', metrics.meta.last_error_at]);
  }

  if (exportMeta.summary?.length) {
    lines.push('');
    push(['section', 'metric', 'value']);
    exportMeta.summary.forEach((item) => {
      push(['summary', item.label, item.value]);
    });
  }

  const capacity = metrics.capacity || {};
  Object.entries(capacity).forEach(([key, value]) => push(['capacity', key, value]));

  if (metrics.queue) {
    lines.push('');
    push(['section', 'field', 'value']);
    Object.entries(metrics.queue).forEach(([key, value]) => push(['queue', key, value]));
  }

  const projects = metrics.projects || {};
  push(['projects', 'total', projects.total ?? 0]);
  const envs = projects.environments || {};
  Object.entries(envs).forEach(([env, statuses]) => {
    Object.entries(statuses || {}).forEach(([status, count]) => {
      push(['projects', `${env}_${status}`, count]);
    });
  });

  lines.push('');
  push(['section', 'phase_or_issue', 'count']);
  const podTotals = metrics.pods?.totals || {};
  Object.entries(podTotals).forEach(([phase, count]) => push(['pods_total', phase, count]));
  const podIssues = metrics.pods?.issues || {};
  Object.entries(podIssues).forEach(([issue, count]) => push(['pods_issue', issue, count]));

  lines.push('');
  push(['section', 'nodegroup', 'nodes', 'alloc_cpu_m', 'alloc_mem_mi', 'req_cpu_m', 'req_mem_mi', 'cpu_percent', 'mem_percent', 'monthly_cost']);
  (metrics.nodes?.by_nodegroup || []).forEach((ng) => {
    push([
      'nodegroup',
      ng.name,
      ng.nodes,
      ng.alloc_cpu_m,
      ng.alloc_mem_mi,
      ng.requested_cpu_m ?? 0,
      ng.requested_mem_mi ?? 0,
      ng.cpu_percent ?? '',
      ng.mem_percent ?? '',
      ng.monthly_cost ?? ''
    ]);
  });

  lines.push('');
  push(['section', 'namespace', 'total', 'running', 'pending']);
  const namespaces = metrics.pods?.namespaces || {};
  Object.entries(namespaces).forEach(([ns, data]) => {
    push([
      'namespace',
      ns,
      data.total ?? 0,
      data.phases?.Running ?? 0,
      data.phases?.Pending ?? 0
    ]);
  });

  lines.push('');
  push(['section', 'namespace', 'name', 'node', 'restarts']);
  (metrics.pods?.top_crashloops || []).forEach((pod) => {
    push(['crashloop', pod.namespace, pod.name, pod.node, pod.restarts ?? 0]);
  });

  return lines.join('\n');
}

function exportMetricsCsv(metrics) {
  const summary = buildMetricsSummary(metrics);
  const exportMeta = { exported_at: new Date().toISOString(), summary };
  const csv = metricsToCsv(metrics, exportMeta);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.download = `vibes-metrics-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportAuditCsv(rows) {
  const headers = [
    'created_at',
    'action',
    'admin_key_fingerprint',
    'ip',
    'user_agent',
    'path',
    'method',
    'meta'
  ];
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    const meta = row.meta ? JSON.stringify(row.meta) : '';
    const values = [
      row.created_at,
      row.action,
      row.admin_key_fingerprint,
      row.ip,
      row.user_agent,
      row.path,
      row.method,
      meta
    ];
    lines.push(values.map(escapeCsv).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.download = `vibes-audit-log-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function renderAuditLog(rows) {
  auditLog.innerHTML = '';
  const logContainer = document.createElement('div');
  logContainer.className = 'log';
  const filtered = filterAuditRows(rows);
  if (!filtered.length) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = 'No audit entries found.';
    logContainer.appendChild(item);
  } else {
    filtered.forEach((row) => {
      const item = document.createElement('div');
      item.className = 'log-item';
      const meta = row.meta ? JSON.stringify(row.meta) : '';
      item.textContent = `[${row.created_at}] ${row.action} ${meta}`;
      logContainer.appendChild(item);
    });
  }
  auditLog.appendChild(logContainer);
}

function renderAlerts(rows) {
  if (!alertsList) return;
  alertsList.innerHTML = '';
  if (!rows.length) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = 'No alerts.';
    alertsList.appendChild(item);
    return;
  }
  rows.forEach((alert) => {
    const item = document.createElement('div');
    item.className = 'alert-item';
    const createdAt = alert.created_at ? new Date(alert.created_at).toLocaleString() : '—';
    const ackText = alert.acknowledged_at ? `Acked ${new Date(alert.acknowledged_at).toLocaleString()}` : 'Unacknowledged';
    const data = alert.data || {};
    const meta = [
      data.environment ? `Env: ${data.environment}` : '',
      data.project_id ? `Project: ${data.project_id}` : '',
      data.host ? `Host: ${data.host}` : '',
      data.commit ? `Commit: ${data.commit}` : ''
    ]
      .filter(Boolean)
      .join(' • ');
    item.innerHTML = `
      <div class="alert-header">
        <strong>${alert.message}</strong>
        <div class="alert-actions">
          ${alert.acknowledged_at ? '' : `<button class="ghost small" data-alert-ack="${alert.id}">Acknowledge</button>`}
        </div>
      </div>
      <div class="alert-meta">
        <span class="alert-level ${alert.level}">${alert.level}</span>
        <span>${alert.type}</span>
        <span>${createdAt}</span>
        <span>${ackText}</span>
        ${meta ? `<span>${meta}</span>` : ''}
      </div>
      ${data?.summary ? `<div class="log-item">${data.summary}</div>` : ''}
    `;
    alertsList.appendChild(item);
  });
}

function readAlertFilters() {
  alertFilters.search = (alertsSearch?.value || '').trim();
  alertFilters.type = (alertsType?.value || '').trim();
  alertFilters.level = (alertsLevel?.value || '').trim();
}

function syncAlertFilters() {
  if (alertsSearch) alertsSearch.value = alertFilters.search;
  if (alertsType) alertsType.value = alertFilters.type;
  if (alertsLevel) alertsLevel.value = alertFilters.level;
}

function buildAlertQuery() {
  const params = new URLSearchParams();
  params.set('limit', '50');
  params.set('ack', showAcknowledgedAlerts ? 'all' : '0');
  if (alertFilters.type) params.set('type', alertFilters.type);
  if (alertFilters.level) params.set('level', alertFilters.level);
  if (alertFilters.search) params.set('search', alertFilters.search);
  return params.toString();
}

function exportAlertCsv(rows) {
  const headers = [
    'created_at',
    'type',
    'level',
    'message',
    'data',
    'acknowledged_at',
    'acknowledged_by'
  ];
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    const data = row.data ? JSON.stringify(row.data) : '';
    const values = [
      row.created_at,
      row.type,
      row.level,
      row.message,
      data,
      row.acknowledged_at,
      row.acknowledged_by
    ];
    lines.push(values.map(escapeCsv).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.download = `vibes-alerts-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function loadAlerts() {
  const result = await api(`/admin/alerts?${buildAlertQuery()}`);
  lastAlerts = result.rows || [];
  renderAlerts(lastAlerts);
}

function setLoggedIn(isLoggedIn) {
  loginSection.hidden = isLoggedIn;
  dashboardSection.hidden = !isLoggedIn;
  logoutBtn.hidden = !isLoggedIn;
}

function getToken() {
  return localStorage.getItem(STORAGE_KEY);
}

function setToken(token) {
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function api(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data?.error || res.statusText);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function shouldLogoutForError(err) {
  const code = err?.status;
  if (code === 401 || code === 403) return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('unauthorized') || msg.includes('admin_forbidden') || msg.includes('admin_access_disabled');
}

function renderStats(container, rows) {
  container.innerHTML = '';
  rows.forEach(({ label, value }) => {
    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    container.appendChild(row);
  });
}

function renderQueueHealth(queue) {
  if (!queueSummary) return;
  if (!queue || queue.error) {
    queueSummary.innerHTML = '';
    if (queueNotice) {
      queueNotice.textContent = queue?.error ? `Queue error: ${queue.error}` : 'Queue data unavailable.';
    }
    return;
  }
  renderStats(queueSummary, [
    { label: 'Waiting', value: queue.waiting ?? 0 },
    { label: 'Active', value: queue.active ?? 0 },
    { label: 'Delayed', value: queue.delayed ?? 0 },
    { label: 'Failed', value: queue.failed ?? 0 },
    { label: 'Completed', value: queue.completed ?? 0 },
    { label: 'Backlog', value: queue.backlog ?? 0 }
  ]);
  if (queueNotice) {
    const threshold = Number(queue.threshold || 0);
    if (threshold && queue.backlog >= threshold) {
      queueNotice.textContent = `Backlog above threshold (${queue.backlog}/${threshold}).`;
      queueNotice.classList.add('warn');
    } else {
      queueNotice.textContent = threshold ? `Threshold: ${threshold}` : '';
      queueNotice.classList.remove('warn');
    }
  }
}

function renderTable(container, headers, rows) {
  const table = document.createElement('table');
  table.className = 'table';
  table.innerHTML = `
    <thead>
      <tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
        )
        .join('')}
    </tbody>
  `;
  container.innerHTML = '';
  container.appendChild(table);
}

function barCell(value, color) {
  if (value == null || value === 'n/a') {
    return `<span class="bar-label">n/a</span>`;
  }
  const num = Math.max(0, Math.min(100, Number(value)));
  const label = Number.isFinite(num) ? `${num}%` : 'n/a';
  const width = Number.isFinite(num) ? num : 0;
  return `
    <div class="bar-wrap">
      <div class="bar"><div class="bar-fill" style="width:${width}%;background:${color};"></div></div>
      <span class="bar-label">${label}</span>
    </div>
  `;
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function updateHistory(metrics) {
  const history = loadHistory();
  const cpu = Number(metrics.capacity.cpu_percent);
  const mem = Number(metrics.capacity.mem_percent);
  history.cpu = Array.isArray(history.cpu) ? history.cpu : [];
  history.mem = Array.isArray(history.mem) ? history.mem : [];
  history.ts = Array.isArray(history.ts) ? history.ts : [];
  if (Number.isFinite(cpu)) history.cpu.push(cpu);
  if (Number.isFinite(mem)) history.mem.push(mem);
  history.ts.push(Date.now());
  history.cpu = history.cpu.slice(-30);
  history.mem = history.mem.slice(-30);
  history.ts = history.ts.slice(-30);
  saveHistory(history);
  return history;
}

function renderSparkline(svg, values, color) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const width = 240;
  const height = 40;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (!values.length) return;
  const max = 100;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => {
    const clamped = Math.min(max, Math.max(0, value));
    const y = height - (clamped / max) * (height - 6) - 3;
    const x = index * step;
    return `${x},${y}`;
  });
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', points.join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly);

  const last = points[points.length - 1].split(',');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', last[0]);
  dot.setAttribute('cy', last[1]);
  dot.setAttribute('r', '2.5');
  dot.setAttribute('fill', color);
  svg.appendChild(dot);
}

async function loadDashboard() {
  setStatus('Loading...');
  const [metrics, audits, health, alerts] = await Promise.all([
    api('/admin/metrics'),
    api(`/admin/audit-log?${buildAuditQuery()}`),
    api('/admin/metrics-health').catch(() => null),
    api(`/admin/alerts?${buildAlertQuery()}`).catch(() => ({ rows: [] }))
  ]);
  lastMetrics = metrics;
  renderMetricsSummary(metrics);
  renderMetricsMeta(metrics.meta, health);

  renderStats(capacitySummary, [
    { label: 'Alloc CPU (m)', value: Math.round(metrics.capacity.alloc_cpu_m) },
    { label: 'Requested CPU (m)', value: Math.round(metrics.capacity.requested_cpu_m) },
    { label: 'CPU %', value: metrics.capacity.cpu_percent ?? 'n/a' },
    { label: 'Alloc Mem (Mi)', value: Math.round(metrics.capacity.alloc_mem_mi) },
    { label: 'Requested Mem (Mi)', value: Math.round(metrics.capacity.requested_mem_mi) },
    { label: 'Mem %', value: metrics.capacity.mem_percent ?? 'n/a' }
  ]);

  renderStats(podSummary, [
    { label: 'Running', value: metrics.pods.totals.Running || 0 },
    { label: 'Pending', value: metrics.pods.totals.Pending || 0 },
    { label: 'Failed', value: metrics.pods.totals.Failed || 0 },
    { label: 'CrashLoopBackOff', value: metrics.pods.issues.crash_loop || 0 },
    { label: 'ImagePullBackOff', value: metrics.pods.issues.image_pull_backoff || 0 }
  ]);
  const crashLoops = metrics.pods.top_crashloops || [];
  crashLoopList.innerHTML = '<h3 class="subtle" style="margin-top:12px;">Top CrashLoop Pods</h3>';
  if (!crashLoops.length) {
    crashLoopList.innerHTML += '<div class="log-item">None</div>';
  } else {
    crashLoops.forEach((pod) => {
      const item = document.createElement('div');
      item.className = 'log-item';
      item.textContent = `${pod.namespace}/${pod.name} (restarts: ${pod.restarts || 0})`;
      crashLoopList.appendChild(item);
    });
  }

  const nodegroupRows = metrics.nodes.by_nodegroup.map((ng) => [
    ng.name,
    ng.nodes,
    Math.round(ng.alloc_cpu_m),
    Math.round(ng.alloc_mem_mi),
    Math.round(ng.requested_cpu_m || 0),
    Math.round(ng.requested_mem_mi || 0),
    barCell(ng.cpu_percent ?? null, '#4c8dff'),
    barCell(ng.mem_percent ?? null, '#45c0a3'),
    ng.monthly_cost ?? 'n/a'
  ]);
  renderTable(
    nodegroupTable,
    ['Nodegroup', 'Nodes', 'Alloc CPU (m)', 'Alloc Mem (Mi)', 'Req CPU (m)', 'Req Mem (Mi)', 'CPU %', 'Mem %', 'Monthly $'],
    nodegroupRows
  );

  const namespaceRows = Object.entries(metrics.pods.namespaces)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .map(([ns, data]) => [ns, data.total, data.phases.Running || 0, data.phases.Pending || 0]);
  renderTable(namespaceTable, ['Namespace', 'Pods', 'Running', 'Pending'], namespaceRows);

  const envs = metrics.projects.environments || {};
  const projectRows = [
    { label: 'Total Projects', value: metrics.projects.total },
    { label: 'Dev Live', value: envs.development?.live || 0 },
    { label: 'Dev Offline', value: envs.development?.offline || 0 },
    { label: 'Test Live', value: envs.testing?.live || 0 },
    { label: 'Prod Live', value: envs.production?.live || 0 }
  ];
  renderStats(projectSummary, projectRows);

  renderQueueHealth(metrics.queue);

  lastAuditRows = audits.rows || [];
  renderAuditLog(lastAuditRows);

  lastAlerts = alerts.rows || [];
  renderAlerts(lastAlerts);

  const history = updateHistory(metrics);
  renderSparkline(cpuSpark, history.cpu || [], '#4c8dff');
  renderSparkline(memSpark, history.mem || [], '#45c0a3');

  applyMetaStatus(metrics.meta);
}

async function loadAuditOnly() {
  const audits = await api(`/admin/audit-log?${buildAuditQuery()}`);
  lastAuditRows = audits.rows || [];
  renderAuditLog(lastAuditRows);
}

async function handleLogin(email, password) {
  loginError.textContent = '';
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || 'Login failed');
  }
  if (!data.user?.is_platform_admin) {
    throw new Error('Admin access required');
  }
  setToken(data.token);
  setLoggedIn(true);
  await loadDashboard();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    await handleLogin(email, password);
  } catch (err) {
    loginError.textContent = err.message;
  }
});

logoutBtn.addEventListener('click', () => {
  setToken('');
  setLoggedIn(false);
});

refreshBtn.addEventListener('click', async () => {
  try {
    await loadDashboard();
  } catch (err) {
    const msg = err?.message ? `Error: ${err.message}` : 'Error';
    setStatus(msg, true);
  }
});

if (auditApply) {
  auditApply.addEventListener('click', async () => {
    readAuditFilters();
    syncAuditInputs();
    try {
      await loadAuditOnly();
    } catch (err) {
      const msg = err?.message ? `Error: ${err.message}` : 'Error';
      setStatus(msg, true);
    }
  });
}

if (auditClear) {
  auditClear.addEventListener('click', async () => {
    auditFilters.search = '';
    auditFilters.action = '';
    auditFilters.since = '';
    auditFilters.limit = 50;
    syncAuditInputs();
    try {
      await loadAuditOnly();
    } catch (err) {
      const msg = err?.message ? `Error: ${err.message}` : 'Error';
      setStatus(msg, true);
    }
  });
}

if (auditSearch) {
  auditSearch.addEventListener('input', (event) => {
    auditFilters.search = event.target.value || '';
    renderAuditLog(lastAuditRows);
  });
}

if (auditExport) {
  auditExport.addEventListener('click', () => {
    exportAuditCsv(filterAuditRows(lastAuditRows));
  });
}

if (alertsRefresh) {
  alertsRefresh.addEventListener('click', async () => {
    try {
      await loadAlerts();
    } catch (err) {
      const msg = err?.message ? `Error: ${err.message}` : 'Error';
      setStatus(msg, true);
    }
  });
}

if (alertsToggle) {
  alertsToggle.addEventListener('click', async () => {
    showAcknowledgedAlerts = !showAcknowledgedAlerts;
    alertsToggle.textContent = showAcknowledgedAlerts ? 'Hide acknowledged' : 'Show acknowledged';
    await loadAlerts();
  });
}

if (alertsApply) {
  alertsApply.addEventListener('click', async () => {
    readAlertFilters();
    syncAlertFilters();
    await loadAlerts();
  });
}

if (alertsClear) {
  alertsClear.addEventListener('click', async () => {
    alertFilters.search = '';
    alertFilters.type = '';
    alertFilters.level = '';
    syncAlertFilters();
    await loadAlerts();
  });
}

if (alertsExport) {
  alertsExport.addEventListener('click', () => {
    exportAlertCsv(lastAlerts);
  });
}

if (alertsList) {
  alertsList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-alert-ack]');
    if (!button) return;
    const alertId = button.getAttribute('data-alert-ack');
    if (!alertId) return;
    try {
      await api(`/admin/alerts/${alertId}/ack`, { method: 'POST' });
      await loadAlerts();
    } catch (err) {
      const msg = err?.message ? `Error: ${err.message}` : 'Error';
      setStatus(msg, true);
    }
  });
}

if (metricsExportJson) {
  metricsExportJson.addEventListener('click', () => {
    if (!lastMetrics) return setStatus('No metrics loaded', true);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summary = buildMetricsSummary(lastMetrics);
    exportJson(`vibes-metrics-${stamp}.json`, {
      exported_at: new Date().toISOString(),
      summary: summaryToObject(summary),
      metrics: lastMetrics
    });
  });
}

if (metricsExportCsv) {
  metricsExportCsv.addEventListener('click', () => {
    if (!lastMetrics) return setStatus('No metrics loaded', true);
    exportMetricsCsv(lastMetrics);
  });
}

if (auditToggle && auditCard) {
  auditToggle.addEventListener('click', () => {
    const isExpanded = auditCard.classList.toggle('is-expanded');
    auditToggle.textContent = isExpanded ? 'Collapse' : 'Expand';
  });
}

(async () => {
  syncAuditInputs();
  syncAlertFilters();
  const token = getToken();
  if (!token) {
    setLoggedIn(false);
    return;
  }
  try {
    setLoggedIn(true);
    await loadDashboard();
  } catch (err) {
    if (shouldLogoutForError(err)) {
      setToken('');
      setLoggedIn(false);
      return;
    }
    const msg = err?.message ? `Error: ${err.message}` : 'Error';
    setStatus(msg, true);
    setLoggedIn(true);
  }
})();
