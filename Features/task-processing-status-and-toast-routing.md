# Separate Task Processing Status from Generic Notifications

## Summary
The current UI in `web/src/public/app.js` uses one generic global field, `taskStatusMessage`, for two unrelated concerns:
- persistent task-processing status
- transient operational/error messaging

That field drives the cube animation in `renderSubmit()`, is also shown as a plain notice in `renderCreateProject()`, and is written by task handlers, environment actions, copy actions, and generic `showError()`. Refresh loses the inline processing UI because the actual persisted task/build state is reloaded from the backend, but `taskStatusMessage`, `taskStatusPersistent`, and `activeTaskId` are not rehydrated.

No toast system currently exists. The smallest robust fix is:
- replace the cube/message display with a derived task-processing view model tied to persisted task/build/workspace state
- add a dedicated toast queue for transient non-task notifications
- keep rich contextual errors out of the toast path when they need durable inline treatment

## PHASE 0 — Discovery
- Task submission state is currently managed in frontend globals:
  - `state.activeTaskId`
  - `state.taskStatusMessage`
  - `state.taskStatusPersistent`
  - `setTaskStatus(message, { autoHide, persistent })`
- The cube animation and inline message are rendered only in `renderSubmit()`, but they render whenever `state.taskStatusMessage` is truthy, regardless of what caused it.
- The same generic message field is also rendered in `renderCreateProject()` as a plain inline notice, so the same state is already serving multiple UI contexts.
- Generic server/action messages currently flow into that field from many places:
  - task submit path
  - `taskUpdated` and `buildUpdated` socket handlers
  - development wake/sleep/start/stop/cancel handlers
  - copy-success handlers
  - generic `showError()`
- Persistent backend state already exists:
  - `GET /projects/:projectId/tasks` in `server/src/index.js` returns persisted task rows with `queued`, `running`, `completed`, `failed`
  - `GET /projects` returns per-environment persisted workspace/build status including `selected_task_id`, `selected_commit_sha`, `live_task_id`, `live_commit_sha`, `build_status`, `workspace_state`
  - `GET /projects/:projectId/builds/latest?environment=...` returns latest build status and `ref_commit`
  - `worker/src/index.js` emits `taskUpdated` and `buildUpdated` during task/build progression
- Refresh currently rebuilds `projects`, `tasks`, `latestBuild`, and socket subscriptions, but it does not rebuild the task-processing indicator because that indicator is not derived from the persisted data.
- There is no toast/notification component, store, or provider today.
- This app is not React. It uses a global mutable state object, explicit fetch loaders, socket handlers, and a custom-element shell.

## PHASE 1 — Root Cause Analysis
- Unrelated messages appear in the cube/message area because the cube is keyed off `state.taskStatusMessage`, not off a task-specific status model.
- The generic `setTaskStatus()` API is the main design bug. It is used for:
  - real task-processing transitions
  - user feedback like `Copied`
  - environment actions like `Sleeping Development...`
  - generic request errors via `showError()`
- The current `persistent` behavior is also generic. `taskStatusPersistent` only tells `buildUpdated` whether to keep mutating the message; it does not prove that a task is still actually processing.
- Refresh causes premature disappearance because the inline indicator is driven by transient client state:
  - `activeTaskId`
  - `taskStatusMessage`
  - `taskStatusPersistent`
  These reset on reload and are never reconstructed from `tasks`, `projectStatus`, or `latestBuild`.
- The correct owner for the cube/message display is a derived `taskProcessingView` computed from persistent backend state, plus one short-lived client-only `submissionPending` state to cover the gap between button click and the task row being created.

## PHASE 2 — Task-Processing UI Separation Plan
- Replace `taskStatusMessage` as the inline-processing source with a selector like `deriveTaskProcessingView(state)`.
- The selector should only consider the development task flow and only return a visible inline state for:
  - `submission_pending`: submit clicked, request in flight, no persisted task row yet
  - `queued`: newest development task has persisted status `queued`
  - `running`: newest development task has persisted status `running`
  - `deploying_or_verifying`: newest relevant task is completed, and the persisted development build/workspace state shows a follow-on build/verification still in progress for that task
- The selector should not show the cube/message for:
  - wake/sleep/start/stop development actions not tied to a task
  - manual deployment of saved sessions
  - copy/download/upload confirmations
  - generic API errors
  - plan/quota/gating notices
- For post-task build attribution, do not use `build_status === 'building'` alone. Require a persisted task link:
  - `project.environments.development.selected_task_id`
  - or `live_task_id`
  - and/or `selected_commit_sha` / `live_commit_sha` matching the task commit and latest build `ref_commit`
- Inline message mapping should be explicit and enum-based, not message-text-based:
  - `submission_pending` -> `Reading Request`
  - `queued` -> `Reading Request`
  - `running` -> `Designing and implementing changes`
  - `deploying_or_verifying` -> `Deploying your update`
- `taskUpdated` and `buildUpdated` should stop calling `setTaskStatus()` for processing messages. They should only update persisted slices (`tasks`, `latestBuild`, project environment state), then let the derived selector control visibility and text.
- Keep one special ephemeral state: `taskSubmissionPending`. It starts on submit click and clears on:
  - successful task creation response
  - failed submit response
  - project/environment switch

## PHASE 3 — Toast Routing Plan
- Add a small toast queue in `web/src/public/app.js`:
  - `state.toasts = []`
  - each toast: `{ id, tone, message, html?, createdAt, expiresAt, dedupeKey }`
- Add helpers:
  - `pushToast({ message, tone, durationMs = 3000, dedupeKey, allowHtml = false })`
  - `dismissToast(id)`
  - centralized timer cleanup
- Route transient non-task messages to toasts:
  - development wake/sleep/start/switch confirmations
  - stop/cancel environment confirmations
  - copy success messages
  - generic non-contextual request failures
  - task terminal outcomes that are no longer `processing`
    - success toast when task-linked build becomes live
    - error/warning toast when task-linked build fails or is cancelled
- Keep rich contextual errors out of the 3-second toast path:
  - plan-limit / upgrade CTA errors now produced by `formatPlanError()`
  - quota notices already rendered inline
  - project/settings/env-specific inline message fields already in state
- Replace the current `showError()` with split behavior:
  - transient operational errors -> toast
  - rich contextual errors -> dedicated local notice field for the relevant region
- Add dedupe so the same logical event is not shown twice from both an action handler and a later socket event. Use keys like:
  - `env-action:${projectId}:${env}:${action}`
  - `task-result:${taskId}:${status}`
  - `build-result:${projectId}:${env}:${refCommit}:${status}`
- Do not show both a toast and the inline cube for the same active processing state.

## PHASE 4 — Styling Plan
- In `web/src/public/styles.css`, keep the cube styling but scope the inline message text to a gray tone:
  - add `.task-status .status-text { color: var(--muted); }`
  - in dark mode, keep it muted rather than accent-colored
  - retain current weight/spacing unless a small reduction is needed for hierarchy
- Add a fixed toast stack under the sticky header:
  - top-right placement below the header bar
  - stack spacing with small vertical gap
  - max visible stack of 3 before older ones collapse or are removed
- Toast styling should follow the existing surface system:
  - rounded corners consistent with cards/buttons
  - padded body
  - readable medium-weight text
  - subtle shadow and border
  - severity variants:
    - success = green
    - error = red
    - warning = yellow
    - info = blue/accent
- Use theme-aware light/dark colors rather than hardcoding one palette only.
- Toast body should support plain text by default and trusted local HTML only for explicitly allowed contextual cases if needed later.

## PHASE 5 — Refresh / Persistence Correctness Plan
- Persistent source of truth for task-processing display:
  - newest development task from `GET /projects/:projectId/tasks`
  - current development environment status from `GET /projects`
  - latest development build from `GET /projects/:projectId/builds/latest`
  - live socket updates from `projectStatus`, `taskUpdated`, and `buildUpdated`
- On initial project load and after refresh:
  - fetch `tasks` and `latestBuild` as part of the current project bootstrap
  - use the already-loaded project environment snapshot from `loadProjects()`
  - recompute `taskProcessingView` after each relevant load completes
- Do not persist the inline message string itself in local storage.
- Add a small hydration guard for the indicator:
  - treat task-processing state as `unknown` until the current project’s `tasks` and development `latestBuild` have loaded
  - avoid explicitly hiding the indicator based on empty defaults before hydration completes
- Transition rules:
  - show inline indicator when selector returns `submission_pending`, `queued`, `running`, or `deploying_or_verifying`
  - hide inline indicator when persistent task/build state reaches terminal non-processing states
  - emit a terminal toast when a tracked task flow reaches live/failed/cancelled
- This avoids premature disappearance on refresh because the indicator is rebuilt from persisted rows and environment/build linkage, not from transient memory.

## PHASE 6 — Implementation Blueprint
- Primary files:
  - `web/src/public/app.js`
  - `web/src/public/styles.css`
  - backend read paths already exist in `server/src/index.js`; no API contract change is required unless implementation discovers a missing task/build linkage edge case
- Frontend changes in `app.js`:
  - remove `taskStatusMessage` / `taskStatusPersistent` / `activeTaskId` as the generic status system
  - add:
    - `taskSubmissionPending`
    - `toasts`
    - any local contextual notice fields needed to replace current generic uses
  - add selectors:
    - `currentDevelopmentTask()`
    - `deriveTaskProcessingView()`
    - `taskBuildMatchesProcessingFlow()`
  - add toast helpers and render function
  - change `renderSubmit()` to render the cube/message only from `deriveTaskProcessingView()`
  - remove `taskStatusMessage` usage from `renderCreateProject()`
  - audit every current `setTaskStatus()` call and re-route it to:
    - derived inline task-processing state
    - toast
    - existing contextual inline state
- Recommended implementation order:
  1. Add typed processing/toast/context-notice state and helper APIs
  2. Add toast rendering and CSS
  3. Implement the derived task-processing selector from persisted data
  4. Rewire submit/task/build/socket flows to stop writing generic inline messages
  5. Re-route non-task action messages to toasts
  6. Add hydration guard for refresh correctness
  7. Remove dead `taskStatusMessage` callsites and verify no region still depends on it
- Risks to handle:
  - double toasts from action handlers and socket echoes
  - misclassifying manual development builds as task-processing
  - brief refresh flicker before task/build hydration completes
  - plan/quota errors losing context if accidentally pushed into 3-second toasts

## Test Plan
- Submit a development task:
  - cube + inline message appear immediately
  - queued/running/deploying transitions follow persisted server state
- Refresh while the task is queued/running/building:
  - cube + inline message reappear after bootstrap if backend still says processing
- Complete the task:
  - inline cube/message hides when the persisted processing flow ends
  - success toast appears for completion/live transition
- Trigger task-linked failure/cancel:
  - inline cube/message hides
  - error/warning toast appears
- Trigger non-task messages:
  - wake development
  - sleep development
  - stop/cancel environment
  - copy logs
  All should show as toasts, not in the cube area.
- Verify toasts:
  - auto-hide after 3 seconds
  - correct severity colors
  - correct dark/light styling
  - stack and dedupe behavior
- Verify rich contextual errors:
  - plan/quota/gating messages remain in dedicated inline contexts and do not flash away as transient toasts
- Validation command for the CLI task:
  - `node --check web/src/public/app.js`

## Assumptions
- No new backend endpoint is required; existing task/build/project status endpoints are sufficient.
- Toasts are a new minimal frontend addition, not a separate framework or library.
- Rich contextual errors should remain contextual, not auto-hide as toasts.
- The cube/message presentation is reserved exclusively for task-processing states and should never again depend on arbitrary message text.
