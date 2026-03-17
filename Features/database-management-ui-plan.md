# Database Management UI Plan

## Summary
Build a serious, project-scoped, environment-scoped database management surface inside the existing Vibes Platform app. The right product model for this repo is not "one loose database console for everything"; it is "the database for the selected project and environment", because customer databases are currently provisioned per `project_id + environment`, while ownership and auth live in the shared control-plane server.

This should be implemented as an authenticated, API-mediated product surface in the existing web app, not by exposing raw database credentials to the browser. The backend should enforce project ownership, plan environment access, query limits, timeouts, and audit logging. The frontend should add a first-class database workspace with schema exploration, row browsing, safe SQL execution, and guarded editing flows.

The current codebase already gives us useful anchors:
- Control-plane auth and tenancy checks in `server/src/index.js`
- Per-environment customer DB identity in `environments.db_name` / `environments.db_url`
- Customer DB provisioning helpers in `worker/src/index.js`
- A public-app placeholder for database UI in `web/src/public/app.js` via `renderDatabaseCard()`
- A destructive database helper already exposed as `POST /projects/:projectId/env/:environment/empty-db`

The plan below keeps the current architecture, adds clear boundaries, and stages the feature as MVP -> strong V1 -> later enhancements.

## PHASE 0 - Repo and architecture discovery

### Backend architecture
- The product backend is an Express server in `server/src/index.js`.
- Auth is JWT-based via `requireAuth` in `server/src/auth.js`.
- Project tenancy is enforced with `ensureProjectOwner(projectId, userId)` in `server/src/index.js`.
- The server currently talks only to the control-plane Postgres database through `server/src/db.js`.
- A separate worker process in `worker/src/index.js` provisions and manages runtime resources, builds, deployments, and customer databases.

### Frontend architecture
- The customer web UI is not React. It is a monolithic custom-element app in `web/src/public/app.js` with a global mutable `state` object and manual `render()` calls.
- Styling lives in `web/src/public/styles.css`.
- There is no existing customer-facing table/grid/editor component system beyond general cards, forms, toggles, modals, badges, and layout primitives.
- There is an unused `renderDatabaseCard()` stub in `web/src/public/app.js` and a minimal "Database" section in `renderAdvanced()` that only exposes `Empty Database`.

### Current database model
- The control-plane database stores platform metadata: `users`, `projects`, `environments`, `tasks`, `sessions`, `builds`, and `project_workspaces`.
- `server/migrations/004_env_db_fields.sql` adds `db_name` and `db_url` to `environments`.
- `worker/src/index.js` derives customer database names with `dbNameFor(shortId, environment)` and URLs with `dbUrlFor(dbName)`.
- `worker/src/index.js` provisions missing customer databases with `ensureDatabase(dbName)`.

### Project / user / environment representation
- Users own projects through `projects.owner_id`.
- Environments are stored per project in the `environments` table and already carry deployment/build status plus DB identity.
- Runtime-specific development state is stored in `project_workspaces`, but database identity is still environment-scoped.
- The current product mental model in the codebase is therefore:
  - one control-plane DB for platform metadata
  - one customer app DB per project environment (`development`, `testing`, `production`)

### Current DB provisioning / management
- Customer DB creation is handled in the worker, not the server.
- The worker persists `db_name` and `db_url` back into `environments`.
- The server already exposes one DB-adjacent destructive action: `POST /projects/:projectId/env/:environment/empty-db`.
- There are no schema introspection, row browsing, or SQL execution APIs for end users today.

### Auth / authorization / plan boundaries
- JWT auth is already in place.
- Ownership is project-scoped with `ensureProjectOwner`.
- Environment access is already gated by plan through `ensurePlanEnvAllowed`.
- Admin-only logging exists via `admin_audit_log`, but there is no customer-facing database audit trail yet.

### Existing internal/admin tools
- There is an internal admin surface under `server/src/admin/`, including a simple table renderer and admin CSS, but it is platform-admin-specific and not suitable as-is for the customer app.
- There is no existing customer DB explorer, SQL console, or reusable query execution service.

### Secrets / connection handling
- The worker has `CUSTOMER_DB_ADMIN_URL` and customer DB connection config needed to create DBs.
- The server config does not currently expose customer DB admin credentials.
- `environments.db_url` is stored in the control-plane DB and is sufficient for connecting to the specific environment database after ownership checks, but it must never be returned to the browser.

### UI system / reusable pieces
- Public UI tokens and components live in `web/src/public/styles.css`.
- Existing public-app patterns that can be reused:
  - card layouts
  - modal layouts
  - buttons, toggles, badges, notices
  - split grid layouts
- Existing public-app gaps that must be added:
  - data explorer layout
  - result grid / data table
  - SQL editor surface
  - pagination / filter UI
  - toast/inline status strategy for DB actions

## PHASE 1 - Product scope analysis

### What "commercial-grade database UI" should mean in this repo
For Vibes Platform, "commercial-grade" should mean:
- users can inspect and manage the database that belongs to the selected project and environment
- the UX is serious enough for debugging, support, migration verification, and real production operations
- the UI is safe by default and explicit about destructive actions
- the browser never gets loose DB credentials
- behavior matches the repo's existing environment model, not a generic shared-database console

### Recommended user mental model
- The primary mental model should be: `Project -> Environment -> Database`.
- Not one database per deployment.
- Not one schema per project inside a shared database.
- The actual codebase provisions databases per environment already, so the UI should surface environment selection explicitly and naturally.

### How it should fit into the existing app
- Short term: make database management a first-class project surface in the authenticated app, using the current selected project and selected environment.
- Best anchor: implement `renderDatabaseCard()` in `web/src/public/app.js` as a real, full-width database workspace.
- Keep destructive helpers like `Empty Database` inside a dedicated "Danger Zone" within the database surface rather than leaving them as isolated buttons in the generic advanced card.
- Near-term UX recommendation: show the database surface when a project is selected and the user is in `advanced` nerd level, because that is where similar power-user controls already live.
- Longer-term: if adoption is high, promote Database to its own always-visible project section independent of nerd level.

### Scope recommendation
#### MVP
- Environment-scoped database explorer
- Schema / table / view navigation
- Column metadata, constraints, index summary
- Row browsing with pagination
- Read-only SQL editor for `SELECT` / `WITH` / `EXPLAIN`
- Result grid with copy/export basics
- Row filters and sorting for structured browsing
- Danger Zone with existing `Empty Database` action
- Server-side ownership checks, row limits, statement timeouts, audit records

#### Strong V1
- Insert / update / delete rows for tables with a primary key or unique row identity
- Recent query history
- Better result-grid affordances
- Query status panel with timing / row count / errors
- Guarded write SQL mode for development and testing
- Production read-only by default unless explicitly allowed

#### Later
- Saved queries
- SQL autocomplete / schema-aware hints
- Query formatting
- Query cancellation
- CSV import/export workflows
- Schema change actions with stronger confirmations
- Side-by-side diff views between environments

## PHASE 2 - Security and tenancy model

### Core principle
All database access must go through authenticated Vibes APIs. Do not expose `db_url`, usernames, passwords, or raw database credentials to the browser.

### Access boundaries
- A user may only access databases for projects they own.
- Environment access must reuse the existing plan/environment checks already used elsewhere in `server/src/index.js`.
- The API layer must resolve the target DB from the selected `projectId + environment`, not from any client-provided connection string.

### Connection model
- Recommended architecture: app-managed APIs only.
- The browser sends project/environment plus intended action.
- The server verifies ownership and environment entitlement, resolves the environment DB internally, executes the allowed operation, and returns sanitized metadata/results.

### Read vs write boundaries
- MVP:
  - structured browsing is read-only
  - SQL editor is read-only
  - production should be read-only
- Strong V1:
  - structured row insert/update/delete for allowed environments
  - guarded write SQL in development/testing
- Production write access should not be casual. It should require:
  - stronger confirm UX
  - higher trust level or feature flag
  - fuller audit trail
  - likely a later phase, not MVP

### Dangerous operations
- `DROP`, `TRUNCATE`, broad `DELETE`, broad `UPDATE`, and schema-changing DDL should not be allowed in MVP SQL execution.
- Existing `Empty Database` should remain a special-purpose explicit action with a hard confirmation.
- When write SQL is later introduced:
  - allow only one statement at a time
  - require explicit write mode
  - show a confirmation step for destructive keywords
  - apply tighter timeouts and logging

### Guardrails
- Enforce one statement per request.
- Enforce statement timeout.
- Enforce row/result-size caps.
- Enforce rate limiting per user/project.
- Disable or block:
  - `COPY`
  - `LISTEN` / `NOTIFY`
  - `CREATE EXTENSION`
  - role/session-changing statements
  - multi-statement execution
- Use server-side identifier validation so schema/table names are selected from introspected metadata, not blindly interpolated.

### Audit logging
- Add a customer-facing DB audit table in the control-plane DB.
- Recommended fields:
  - `user_id`
  - `project_id`
  - `environment`
  - action type
  - target schema/table if applicable
  - query hash
  - short query preview
  - success/failure
  - duration
  - affected rows
  - IP / user agent
- Do not store full result sets.
- Be cautious about storing full SQL text; use preview + hash in MVP, with opt-in richer history later.

## PHASE 3 - Data access architecture

### Recommended backend architecture
Add a dedicated "database access" backend layer on the server side, because the server already owns auth and project tenancy.

### Required backend additions
#### 1. Shared customer DB resolution module
Extract shared DB helper logic so server and worker do not drift:
- `dbNameFor`
- `dbUrlFor`
- `dbUrlMatchesConfig`
- "ensure environment database exists" logic

Recommended location:
- new shared backend utility, for example `server/src/customer-db.js` plus a matching worker import, or a shared module under a repo path both can import.

#### 2. Server customer DB connection support
The server currently lacks customer DB admin config. For a robust database UI it should gain:
- customer DB config in `server/src/config.js`
- a customer DB connection helper that:
  - resolves the target environment row
  - verifies `db_url`
  - optionally provisions the DB if missing or stale
  - opens a scoped `pg` client to that environment DB

#### 3. Database UI API surface
Add project-scoped endpoints under a consistent namespace, for example:
- `GET /projects/:projectId/database/:environment/catalog`
- `GET /projects/:projectId/database/:environment/objects/:schema/:object`
- `GET /projects/:projectId/database/:environment/objects/:schema/:object/rows`
- `POST /projects/:projectId/database/:environment/query`
- `POST /projects/:projectId/database/:environment/rows`
- `PATCH /projects/:projectId/database/:environment/rows`
- `DELETE /projects/:projectId/database/:environment/rows`
- `GET /projects/:projectId/database/:environment/history`

The exact URL shape can shift, but metadata, row browsing, SQL execution, and audit/history should be separated cleanly.

### API categories
#### Metadata / introspection APIs
Use `information_schema` and `pg_catalog` to return:
- visible schemas
- tables
- views
- columns
- types
- nullability
- defaults
- primary keys
- foreign keys
- indexes
- estimated row counts

Exclude system schemas by default:
- `pg_catalog`
- `information_schema`
- `pg_toast`

#### Row browsing APIs
Use structured APIs for browsing so the server controls limits and query shape:
- default page size `100`
- max page size `500`
- server-side sorting on allowed columns
- simple filter operators for MVP
- exact row counts only on demand
- otherwise use estimated counts from `pg_class.reltuples`

Prefer keyset pagination when a stable primary key exists; fall back to limit/offset where necessary for MVP.

#### SQL execution API
MVP SQL execution should be read-only:
- one statement only
- allow `SELECT`, `WITH`, `EXPLAIN`
- reject write / DDL / session-control statements
- wrap in a read-only transaction
- apply statement timeout
- cap returned rows / cells

Because `pg` materializes result sets in memory, the MVP query runner should not pretend to support huge raw query outputs. Keep strict caps and return truncation metadata.

#### Mutation / editing APIs
Do not start with arbitrary write SQL.
For V1, add structured row mutations first:
- insert row
- update row by primary key
- delete row by primary key

Only enable structured editing where the table has a clear row identity. If a table has no usable key, keep it read-only in the structured browser and require SQL for later advanced workflows.

#### Audit / logging path
Every metadata browse, SQL execution, and row mutation does not need the same audit depth. Recommended split:
- metadata browse: light audit or sampled audit
- SQL execution: full audit metadata
- row mutations: full audit metadata
- dangerous actions: full audit metadata + explicit confirmation reason later if needed

### Error handling
Return structured errors with:
- `code`
- `message`
- `retryable`
- `details` only when safe

Do not leak raw connection strings, role names, or internal backend traces to the browser.

### Multi-environment selection
- Reuse the app's existing `state.environment` selector in the header.
- Every database request should be scoped to the currently selected environment.
- The UI should always make the environment explicit to reduce operator error.

## PHASE 4 - Frontend UX plan

### Recommended information architecture
Build a dedicated database workspace in the authenticated project view.

Recommended layout:
- left sidebar: schemas -> tables/views
- main top area: object summary + column/constraint/index metadata
- main lower area:
  - data browser tab
  - SQL editor tab
  - optional query history tab
- right-side or bottom inspector for selected row details in V1

### Where it should live
- Use `renderDatabaseCard()` in `web/src/public/app.js` as the anchor for the new surface.
- Keep it project-scoped and environment-scoped.
- Near term, show it in advanced mode with the existing power-user tools.
- Longer term, promote it into a clearer project section once the UX proves out.

### UI flows
#### Explorer
- User selects schema
- User selects table or view
- UI loads metadata and first page of rows
- Header shows object type, estimated row count, last query status, and environment badge

#### Data browser
- Paginated grid
- sortable columns
- simple filter bar
- row count / truncation message
- copy cell / copy row actions

#### SQL editor
- Multi-line editor
- run button
- result grid
- error panel
- duration + rows returned
- explicit mode badge: `Read-only`

#### Danger Zone
- Move the current `Empty Database` action into the database surface
- Add a strong confirmation modal
- Keep it visually separated from normal browsing/querying

### Reuse vs new components
Reuse from current public app:
- cards
- buttons
- modals
- notices
- badges
- current project/environment header controls

Add new reusable pieces:
- database explorer tree
- data grid
- filter bar
- query result panel
- empty/loading/error states specific to database actions

Do not import the admin UI directly into the public app. It is a different product surface. Use the public theme tokens from `web/src/public/styles.css`, while borrowing structural ideas from the admin table styles if helpful.

### UX polish requirements
To feel commercially credible:
- persistent environment label
- good empty states
- obvious loading states
- truncated-result messaging
- explicit read-only vs writable indicators
- keyboard-friendly grid and editor interactions where practical
- no cramped debug-panel styling

## PHASE 5 - SQL editor and table browsing scope

### Recommended balance
Start with explorer-first, SQL-second.

Reason:
- the codebase already models projects and environments, not raw DB endpoints
- many users need browse/filter/inspect before they need raw SQL
- explorer-first is safer and more approachable
- SQL editor is still essential for credibility, but should not be the only workflow

### Landing recommendation
- Default landing state: explorer with the most relevant user schema selected.
- SQL editor available as a sibling tab, not the default blank screen.

### Structured editing vs raw SQL
#### MVP
- structured browse and filter
- read-only SQL editor

#### Strong V1
- in-grid row editing for tables with a primary key
- insert modal or row form
- delete confirmation
- write SQL mode behind explicit toggle and stronger confirmations

### SQL validation strategy
MVP:
- single statement only
- lightweight server-side statement classifier
- allow only read-only classes
- wrap in read-only transaction

V1:
- introduce a stronger parser/classifier before allowing write SQL broadly
- still keep one statement per request

### Query history
- MVP: recent queries stored locally in browser storage per `user + project + environment`
  - this avoids immediately storing potentially sensitive SQL centrally
- V1: optional server-side recent history with scoped ownership and audit rules

### Minimum credible editor feature set
For V1 credibility, the SQL editor should at minimum have:
- multi-line editing
- Run
- clear result/error state
- recent query recall
- duration + row count
- read-only / write-mode badge

Autocomplete and formatting can come later.

## PHASE 6 - Operational and performance considerations

### Large result sets
- Never try to render unlimited rows.
- Structured browse:
  - page size default `100`
  - max `500`
- SQL results:
  - strict row cap
  - explicit truncation notice

### Timeouts
- Metadata queries: short timeout
- Browse queries: moderate timeout
- SQL runner: explicit statement timeout, stricter in production than development

### Memory and backend protection
- Because the backend uses `pg`, avoid unbounded result materialization.
- Prefer capped result sets and structured browse endpoints for anything large.
- Reject or truncate oversized responses before they become UI problems.

### Long-running queries
- MVP: fail fast with timeout and clear error
- Later: async query execution and cancellation if demand justifies it

### Concurrency / abuse protection
- Rate-limit SQL execution endpoints per user/project
- Limit concurrent database actions per project/environment
- Log repeated timeout/failure patterns

### Observability
- Add dedicated server logging for:
  - query duration
  - timeout events
  - blocked statement classes
  - result truncation
  - mutation counts

### Schema changes while UI is open
- Treat metadata as refreshable
- Provide a manual refresh action in MVP
- Invalidate current table metadata/results when a schema-changing action is detected later

## PHASE 7 - Permissions and product boundaries

### Access level recommendation
Use environment-aware access levels.

#### MVP
- `development`
  - full metadata browse
  - row browse
  - read-only SQL
- `testing`
  - same as development if the plan includes testing
- `production`
  - metadata browse
  - row browse
  - read-only SQL only

#### Strong V1
- `development`
  - structured read/write
  - optional guarded write SQL
- `testing`
  - structured read/write
  - optional guarded write SQL
- `production`
  - still read-only by default
  - destructive/write actions only behind stronger controls if product direction demands it

### Plan / feature gating
- Reuse existing environment plan gating first.
- Add a dedicated DB-management plan gate only if product packaging requires it.
- Do not make the core architecture depend on pricing decisions.

### Read-only vs read-write modes
- The UI should visibly distinguish read-only and writable contexts.
- Production should display a persistent read-only badge in MVP.
- Write modes should require explicit user intent, not be ambient.

### Destructive confirmations
- Existing `Empty Database` stays behind a hard confirmation.
- Future destructive SQL/write operations should require:
  - a confirmation modal
  - target table summary
  - estimated affected rows where feasible

## PHASE 8 - Repo-specific implementation blueprint

### Backend files likely involved
- `server/src/index.js`
  - add new database UI routes
  - reuse `requireAuth`, `ensureProjectOwner`, and plan environment checks
- `server/src/config.js`
  - add customer DB connection/admin config required by the server-side DB access layer
- `server/src/db.js`
  - keep control-plane DB access separate
- new module, recommended:
  - `server/src/customer-db.js`
  - responsibilities:
    - resolve target environment DB
    - validate/provision DB connection info
    - open/close customer DB clients
- new module, recommended:
  - `server/src/database-ui.js`
  - responsibilities:
    - metadata queries
    - browse queries
    - SQL execution
    - mutation helpers
    - query classification / limits
- `worker/src/index.js`
  - extract shared DB naming/provision helpers if the server now needs the same logic
- `server/migrations/023_database_console_audit.sql`
  - add customer DB audit table

### Frontend files likely involved
- `web/src/public/app.js`
  - add database UI state:
    - selected schema/object
    - metadata cache
    - rows cache
    - pagination/sort/filter state
    - SQL draft
    - SQL result/error state
    - query history
    - DB action notices
  - implement `renderDatabaseCard()`
  - add DB event handlers and API loaders
  - move `Empty Database` into the DB surface
- `web/src/public/styles.css`
  - add explorer, grid, editor, and danger-zone styling

### Shared contracts
Even in a JS codebase, add shared constants/enums for:
- object types: `table`, `view`
- query modes: `read`, `write`
- audit action types
- API error codes

### Recommended API surface
#### MVP
- catalog introspection
- object metadata
- row browse
- read-only SQL execute
- recent query list
- danger-zone DB empty action reuse

#### Strong V1
- structured insert/update/delete
- optional guarded write SQL
- server-backed recent history if desired

### Recommended UI surface
#### MVP
- one full-width database card/panel inside the selected project view
- uses current project + environment context
- explorer + metadata + browse + read-only SQL

#### Strong V1
- richer row inspector/editor
- query history panel
- more polished grid interactions

### Recommended order of implementation
1. Extract / create backend customer DB resolution helpers
2. Add audit migration and server-side DB access module
3. Implement metadata and browse endpoints
4. Implement read-only SQL endpoint with guardrails
5. Build `renderDatabaseCard()` explorer + browse UI
6. Add SQL editor + result grid
7. Move `Empty Database` into the DB Danger Zone
8. Add recent query history
9. Add structured row editing for V1

### Repo-specific risks / pitfalls
- The current public app rerenders aggressively from a single global state object. A large editable DB surface will be especially sensitive to that.
  - Do not store editor and grid draft state in a way that gets wiped by unrelated app refreshes.
  - Prefer local DB-surface state slices and careful update boundaries.
- The server currently does not have customer DB admin config; provisioning behavior must be designed intentionally, not assumed.
- `environments.db_url` exists, but stale/missing values must be handled safely.
- Production write access is the highest operational risk and should not be casually included in MVP.
- Raw SQL result sets can easily become memory/performance problems if caps are not enforced.

## PHASE 9 - Testing strategy

### Backend tests
Add focused Node tests for the new database-access layer and route behavior.

Cover:
- project ownership enforcement
- plan environment enforcement
- environment DB resolution
- schema/table identifier validation
- metadata introspection correctness
- browse pagination and sorting
- read-only SQL classification
- rejection of blocked statements
- timeout handling
- result truncation metadata
- audit log writes

### Mutation / dangerous action tests
For V1:
- insert/update/delete only on eligible tables
- rejection when no primary key / row identity exists
- destructive confirmation flows
- production write restrictions

### Frontend validation
Because the frontend is a custom-element app without an existing dedicated UI test harness, plan for:
- manual workflow validation in the browser
- lightweight API/state tests where practical

Manual scenarios:
- open Database for selected project/environment
- browse schemas and tables
- inspect columns / constraints / indexes
- page through rows
- apply sorting/filtering
- run read-only SQL and inspect result grid
- refresh while Database is open and ensure the selected project/environment context survives reasonably
- trigger blocked SQL and verify the error is explicit
- trigger `Empty Database` and verify confirmation and success/failure handling
- verify production view remains read-only in MVP

### Performance / large dataset checks
- browse large tables with pagination
- verify capped SQL results
- verify timeouts on intentionally expensive queries
- confirm the app remains responsive with large metadata payloads and result sets

## MVP / V1 / Later summary

### MVP
- project/environment database explorer
- metadata introspection
- paginated row browsing
- read-only SQL editor
- result grid
- audit logging
- Danger Zone with `Empty Database`
- production read-only

### Strong V1
- structured row editing
- recent query history
- better grid ergonomics
- guarded write SQL for non-production

### Later
- autocomplete
- formatting
- cancellation
- saved queries
- richer production controls
- schema migration workflows

## Recommended next-step command
Run the agent-task CLI with this plan:

```sh
make agent-task ARGS="--branch feat/database-management-ui --prompt-file Features/database-management-ui-plan.md --feature-validation-cmd 'node --check web/src/public/app.js && node --check server/src/index.js && node --check worker/src/index.js'"
```
