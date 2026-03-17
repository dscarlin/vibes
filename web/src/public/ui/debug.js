function isDebugEnabled() {
  return Boolean(window.__VIBES_DEBUG_RENDERS__);
}

function activeElementSnapshot() {
  const active = document.activeElement;
  if (!active) return null;
  return {
    tag: active.tagName,
    id: active.id || '',
    name: active.getAttribute('name') || '',
    key: active.getAttribute('data-debug-key') || ''
  };
}

export function debugRender(event, details = {}) {
  if (!isDebugEnabled()) return;
  console.debug(`[vibes-render] ${event}`, {
    ...details,
    activeElement: activeElementSnapshot()
  });
}

export function debugUpdateBoundary(name, changedKeys, beforeActive) {
  if (!isDebugEnabled()) return;
  console.debug(`[vibes-render] region:${name}`, {
    changedKeys: Array.from(changedKeys || []),
    beforeActive,
    afterActive: activeElementSnapshot()
  });
}

export function debugCounter(name, details = {}) {
  if (!isDebugEnabled()) return;
  const counters = window.__VIBES_DEBUG_COUNTERS__ || (window.__VIBES_DEBUG_COUNTERS__ = {});
  counters[name] = (counters[name] || 0) + 1;
  console.debug(`[vibes-render] counter:${name}`, {
    count: counters[name],
    ...details
  });
}
