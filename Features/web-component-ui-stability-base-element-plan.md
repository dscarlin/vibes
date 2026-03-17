# Stabilize `app-shell` with a Base Custom-Element Architecture

## Summary
The current instability is caused by full DOM replacement, not React rerendering. In `web/src/public/app.js`, `setState()` calls `app-shell.render()`, and `AppShell.render()` rewrites the shell with `innerHTML`. Background socket, polling, and settings updates therefore recreate large parts of the UI, which explains the blinking and the loss of in-progress input state.

Implement the fix inside the existing web-component architecture. Introduce a small base-element system plus a batched app store, then break the monolithic shell into stable, stateful custom elements that patch their own DOM via `update()` instead of rebuilding the whole app.

## Implementation Changes

### 1. Introduce a shared `BaseElement` contract
- Add a small UI module set under `web/src/public/ui/` and move the frontend toward:
  - `BaseElement`
  - a batched store
  - a few stateful child custom elements
- `BaseElement` should define the common lifecycle and patching contract:
  - render static shell once on first connect
  - cache refs after first render
  - bind delegated event handlers once
  - expose `update(nextProps, prevProps, changedKeys)` for incremental DOM patching
  - provide common helpers like `patchText`, `patchHtml`, `patchValue`, `patchChecked`, `patchClass`, `patchHidden`, `patchDisabled`
- Allow full rerender only for tiny stateless fragments with no editable descendants. Anything with inputs, toggles, menus, modal state, or background updates must patch in place.

### 2. Replace global immediate rerendering with a batched store
- Replace the current `setState()` behavior with a store that:
  - merges patches
  - tracks changed top-level keys
  - batches notifications with `queueMicrotask()` or `requestAnimationFrame()`
  - notifies subscribers selectively
- Keep one central app state object, but subscribe by slice or dependency keys so background updates do not fan out through the whole shell.
- Socket handlers, pollers, and async loaders should update state only; they should not call global render functions directly.

### 3. Split `AppShell` into stable regions with explicit update boundaries
- Keep `AppShell` as the coordinator for bootstrapping, sockets, polling, and top-level action routing.
- Extract stable child elements for the main interactive regions:
  - landing/auth
  - app header and environment status
  - workspace/main content
  - settings modal
  - confirm/prompt/setup/deleting modals
- Pass data down by calling `child.update(slice)` with well-defined props.
- Send actions up with bubbling `CustomEvent('app-action', { detail })`.
- Do not turn every small row into its own custom element. Keep small list rows and badges as local HTML patch helpers inside a parent region unless they hold their own interactive state.

### 4. Separate server state from local draft state
- Add dedicated draft state for editable UI, separate from fetched/server-backed state.
- Cover at minimum:
  - auth modal fields
  - create-project form
  - task prompt
  - rename-project field
  - session-save message
  - deploy webhook URL
  - env vars editor
  - settings inputs, including desktop and healthcheck fields
  - prompt modal input
- Draft rules:
  - seed drafts when a view opens or when entity context changes
  - mark drafts dirty on user input
  - never overwrite dirty drafts from polling/socket refreshes
  - reconcile drafts only on explicit save, cancel, reset, or context change

### 5. Narrow the refresh scope of background activity
- `projectStatus`, `buildUpdated`, runtime-usage refreshes, and polling should update only the affected header/status/log regions.
- Task/session fetches should update only their own list regions.
- Project refreshes should not rebuild modals, forms, or the active editor when the selected project has not changed.
- Modal visibility should be toggled on stable modal elements instead of destroying/recreating modal DOM.

### 6. Add render-path instrumentation before refactor, keep a guarded debug hook after
- Start by instrumenting:
  - changed state keys
  - which regions update
  - active element before/after updates
  - counts of socket/poll-driven updates
- Keep this behind a local debug flag such as `window.__VIBES_DEBUG_RENDERS__` so it can be re-enabled without shipping noisy logs by default.

## Internal Interfaces
- New internal frontend contract:
  - `BaseElement.update(nextProps, prevProps, changedKeys)`
  - centralized batched `setState()` / store subscription API
  - bubbling `app-action` custom events from child elements to `AppShell`
- Keep backend APIs unchanged. This is a frontend architecture fix, not an API redesign.

## Test Plan
- Manual stability checks:
  - type in auth fields while background activity occurs and confirm values/focus survive
  - type in task prompt, env vars, webhook, rename, session-save, and settings fields during socket/poll updates
  - keep settings modal open while runtime/build updates arrive and confirm no field resets
  - confirm header badges and logs update without visible whole-page blink
  - confirm project/environment switches intentionally reset only context-specific drafts
- Diagnostic checks:
  - verify debug instrumentation shows regional updates rather than whole-shell updates during polling/socket events
- Validation command:
  - `find web/src/public -name '*.js' -print0 | xargs -0 -n1 node --check`

## Artifacts
- Plan file target:
  - `Features/web-component-ui-stability-base-element-plan.md`
- CLI command to run this task:
```sh
make agent-task ARGS="--branch fix/web-component-ui-stability --prompt-file Features/web-component-ui-stability-base-element-plan.md --feature-validation-cmd 'find web/src/public -name '\''*.js'\'' -print0 | xargs -0 -n1 node --check'"
```

## Assumptions
- Stay in the current web-component architecture; do not migrate to React.
- Keep behavior and styling intact unless a change is necessary to stop broad refreshes or draft loss.
- Prefer a small number of stateful custom elements plus shared base helpers over a flat collection of raw DOM patch functions.
- `AppShell` remains the top-level controller; children should be view-focused and update from props rather than owning network side effects.
