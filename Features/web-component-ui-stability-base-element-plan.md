# Web Component UI Stability Base Element Plan

- Add a shared `BaseElement` contract under `web/src/public/ui/` for one-time shell rendering, ref caching, delegated binding, and targeted DOM patch helpers.
- Replace the immediate global `setState()` rerender path with a microtask-batched store that tracks changed top-level keys and notifies update boundaries selectively.
- Keep `app-shell` as the top-level coordinator, but render a stable shell once and fan updates into smaller regions instead of replacing the whole application DOM.
- Preserve editable state in dedicated draft objects for auth, create-project, task prompt, session save, deploy webhook, env vars, settings, rename-project, and prompt modal inputs.
- Keep debug instrumentation behind `window.__VIBES_DEBUG_RENDERS__` so changed keys, update boundaries, focus state, and socket/poll counters can be re-enabled during local diagnosis.
