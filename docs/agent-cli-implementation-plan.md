# Internal Agent CLI Implementation Plan

## Scope

This plan is for the Vibes Platform repo as it exists today.

Target outcome:

1. A developer runs an internal repo-local CLI.
2. The CLI creates a disposable clone tied to a feature branch.
3. The clone is wired so the task-scoped platform instance is the default reality inside that clone.
4. Codex CLI runs non-interactively inside that clone, edits code, redeploys, validates, and stops.
5. The CLI sanitizes the clone, commits only feature changes, pushes the branch, then tears down task-owned resources.
6. Logs and evidence survive outside the clone.

This is not a customer feature and should not introduce customer-facing tenancy UX.

## Phase 0: Repo Discovery

### Languages and workspace structure

- Root repo uses npm workspaces: `server`, `worker`, `web`.
- Root [`package.json`](/Users/jccarlin/Documents/VibesPlatform/package.json) is very small and already pins `@openai/codex`.
- `server`, `worker`, and `web` are plain JavaScript ESM packages, not TypeScript.
- Repo-level Node orchestration is already done with `.mjs` scripts in `scripts/`, `validation/`, and `cluster-bootstrap/`.

Conclusion: the natural home for this CLI is repo-level Node `.mjs`, not TypeScript and not a new workspace.

### Existing internal tooling patterns

- Shell orchestration lives in `scripts/`, `deploy/`, and `infra/k8s/`.
- Node orchestration lives in:
  - [`validation/run-replica-flow.mjs`](/Users/jccarlin/Documents/VibesPlatform/validation/run-replica-flow.mjs)
  - [`cluster-bootstrap/sync-secrets.mjs`](/Users/jccarlin/Documents/VibesPlatform/cluster-bootstrap/sync-secrets.mjs)
  - [`scripts/replica/seed-secrets.mjs`](/Users/jccarlin/Documents/VibesPlatform/scripts/replica/seed-secrets.mjs)
- Generated env and deploy metadata already live under ignored `deploy/.generated/`.
- Validation evidence already lives under ignored `validation/evidence/`.

These are the right conventions to extend.

### Make targets and orchestration patterns

[`Makefile`](/Users/jccarlin/Documents/VibesPlatform/Makefile) has two distinct orchestration families:

- Older/default targets:
  - `build-push`
  - `deploy-all`
  - `server-apply`
  - `web-apply`
- Replica/test-cluster targets:
  - `replica-plan`
  - `replica-up`
  - `replica-down`
  - `replica-validate`
  - `replica-seed-secrets`

Important repo fact:

- The older `Makefile` deploy targets use older `infra/k8s/*` scripts and default namespaces.
- The replica flow uses newer `deploy/build-push.sh` + `deploy/apply-platform.sh` + `validation/run-replica-flow.mjs`.

For the internal agent CLI, the replica-style path is the correct base, not `make deploy-all`.

### Deployment model

The live repo deploy model is layered:

1. Terraform Layer 1: VPC, EKS, RDS, ECR, S3, ACM, Route53, IRSA.
2. Terraform Layer 2: add-ons, ALB controller, namespaces, storage class.
3. Scripted Layer 3:
   - [`deploy/build-push.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/build-push.sh)
   - [`deploy/apply-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/apply-platform.sh)
   - [`deploy/destroy-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/destroy-platform.sh)

Customer app deploys are worker-driven through:

- [`infra/k8s/deploy.sh`](/Users/jccarlin/Documents/VibesPlatform/infra/k8s/deploy.sh)
- [`infra/k8s/delete.sh`](/Users/jccarlin/Documents/VibesPlatform/infra/k8s/delete.sh)

Current namespaces are hardcoded throughout the repo:

- `vibes-platform`
- `vibes-development`
- `vibes-testing`
- `vibes-production`

This is the main constraint the task CLI must break open.

### Environment and config handling

There are two config patterns in the repo:

1. Local/root dotenv:
   - root `.env`
   - root `.env.server`
   - root `.env.worker`
   - root `.env.web`
   - root `.env.k8s.apply`
2. Replica/generated envs:
   - `deploy/.generated/replica/metadata.env`
   - `deploy/.generated/replica/server.env`
   - `deploy/.generated/replica/web.env`
   - `deploy/.generated/replica/worker.env`
   - `deploy/.generated/replica/images.env`

This is useful for the clone-local overlay requirement:

- root `.env*` files are already ignored
- `deploy/.generated/` is already ignored

So the repo already has the correct places for generated task-only overlays.

### Database access model

There are two DB layers:

1. Platform DB
   - `server` and `worker` both use `DATABASE_URL`
   - migrations are SQL files under [`server/migrations`](/Users/jccarlin/Documents/VibesPlatform/server/migrations)
   - all queries are unqualified table names
2. Customer app DBs
   - worker creates per-project per-environment databases via `CUSTOMER_DB_ADMIN_URL`
   - naming pattern in worker today is `vibes_<shortid>_<environment>`

Important repo fact:

- The platform schema is migration-driven and unqualified.
- There is no existing schema-per-task support.
- There is no existing `search_path` handling.
- Customer app isolation is database-per-project, not schema-per-project.

### Migration, seeding, and bootstrap patterns

- Platform migrations run in [`server/src/migrate.js`](/Users/jccarlin/Documents/VibesPlatform/server/src/migrate.js) when `RUN_MIGRATIONS=true`.
- Replica DB roles and platform DB bootstrap happen in [`cluster-bootstrap/init-database.sh`](/Users/jccarlin/Documents/VibesPlatform/cluster-bootstrap/init-database.sh).
- Replica runtime env files are synthesized in [`cluster-bootstrap/sync-secrets.mjs`](/Users/jccarlin/Documents/VibesPlatform/cluster-bootstrap/sync-secrets.mjs).

### Test, validation, and E2E patterns

There is no meaningful unit/integration test harness in package scripts today.

The real end-to-end harness is [`validation/run-replica-flow.mjs`](/Users/jccarlin/Documents/VibesPlatform/validation/run-replica-flow.mjs). It already does:

1. register user
2. create project
3. wait for snapshot readiness
4. create development task
5. wait for completion
6. wake preview
7. verify preview marker
8. trigger verified build
9. verify repo download
10. save evidence under `validation/evidence/<timestamp>`

This is the strongest reusable validation surface in the repo.

### Preview and updated-code retrieval

Preview and repo retrieval are already implemented:

- dev workspace preview and preview routing live in [`worker/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/index.js)
- repo bundle persistence and retrieval live in:
  - [`server/src/repo.js`](/Users/jccarlin/Documents/VibesPlatform/server/src/repo.js)
  - [`server/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/server/src/index.js)
  - `/projects/:projectId/repo-download`

### Auth, user, project, and prompt flows

Core endpoints already exist in [`server/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/server/src/index.js):

- `/auth/register`
- `/auth/login`
- `/projects`
- `/projects/:projectId/tasks`
- `/projects/:projectId/development/wake`
- `/projects/:projectId/runtime-logs`
- `/projects/:projectId/repo-download`
- `/projects/:projectId` `DELETE`

Worker jobs already implement:

- `init-project`
- `codex-task`
- `deploy-commit`
- `delete-project`
- `reset-workspace`

### Existing scripts to reuse

The internal task CLI should reuse:

- [`deploy/build-push.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/build-push.sh)
- [`deploy/apply-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/apply-platform.sh)
- [`deploy/destroy-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/destroy-platform.sh)
- [`infra/k8s/deploy.sh`](/Users/jccarlin/Documents/VibesPlatform/infra/k8s/deploy.sh)
- [`infra/k8s/delete.sh`](/Users/jccarlin/Documents/VibesPlatform/infra/k8s/delete.sh)
- [`validation/run-replica-flow.mjs`](/Users/jccarlin/Documents/VibesPlatform/validation/run-replica-flow.mjs)
- [`scripts/status-check.sh`](/Users/jccarlin/Documents/VibesPlatform/scripts/status-check.sh)
- replica metadata/env generation patterns from [`cluster-bootstrap/sync-secrets.mjs`](/Users/jccarlin/Documents/VibesPlatform/cluster-bootstrap/sync-secrets.mjs)

It should not treat the older `Makefile` deploy targets as the primary task-runtime path.

## Phase 1: Best Shape of the Internal CLI

### Recommended location

Tracked code:

- `scripts/agent-task/index.mjs`
- `scripts/agent-task/lib/*.mjs`
- `scripts/agent-task/prompt-template.md`

Reason:

- repo-level orchestration already uses `.mjs` in `scripts/`
- this tool coordinates git, kubectl, aws, Route53, env generation, validation, and cleanup across the whole repo
- it is not specific to `server`, `worker`, or `web`

### JS vs TS

Use JavaScript ESM `.mjs`.

Reason:

- no TypeScript toolchain exists in the repo root
- current repo-level orchestration already uses `.mjs`
- adding TS would create new build friction for an internal tool that mostly shells out

### Command structure

Recommended subcommands:

- `run`
  - end-to-end flow: clone, overlay, deploy, invoke Codex, validate, sanitize, push, cleanup
- `cleanup`
  - rerun cleanup from a saved manifest
- `inspect`
  - print manifest status, resource ownership, artifact paths, and cleanup state
- `plan`
  - optional dry-run that computes names, paths, hosts, schema, and branches without mutating anything

### Make targets

Add thin wrappers only:

- `make agent-task`
- `make agent-task-plan`
- `make agent-task-cleanup`

The Makefile should only call the Node CLI. It should not duplicate logic.

### Run ID, task token, branch, and artifact structure

Use separate identifiers for human-readable run tracking and short k8s-safe resource names.

Recommended:

- `runId`: `20260316T153012Z-feature-login-7c2f1b`
- `taskToken`: short 10-12 char stable token derived from `runId`
- feature branch: exactly user-provided branch name

Recommended persistent artifact root outside the clone:

- `validation/evidence/agent-cli/<runId>/`

Recommended disposable clone location:

- `$TMPDIR/vibes-agent-cli/<runId>/repo`

This matches repo conventions:

- evidence stays under `validation/evidence/`
- generated task state in the clone stays ignored
- the clone stays disposable and outside the main worktree

## Phase 2: Clone-Local Overlay Strategy

This is the core design requirement.

### Files Codex is likely to inspect or use

Codex will naturally inspect:

- [`Makefile`](/Users/jccarlin/Documents/VibesPlatform/Makefile)
- [`deploy/build-push.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/build-push.sh)
- [`deploy/apply-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/apply-platform.sh)
- [`infra/k8s/deploy.sh`](/Users/jccarlin/Documents/VibesPlatform/infra/k8s/deploy.sh)
- [`validation/run-replica-flow.mjs`](/Users/jccarlin/Documents/VibesPlatform/validation/run-replica-flow.mjs)
- root `.env*`
- generated `deploy/.generated/replica/*`

So the overlay should make those surfaces resolve to the task environment by default.

### Recommended clone-local generated files

Generate the following inside the disposable clone:

1. Ignored task directory:
   - `.vp-task/manifest.json`
   - `.vp-task/cleanup.json`
   - `.vp-task/prompt.md`
   - `.vp-task/bin/vp-redeploy`
   - `.vp-task/bin/vp-validate`
   - `.vp-task/bin/vp-status`
   - `.vp-task/bin/vp-runtime-logs`
2. Ignored root env files:
   - `.env`
   - `.env.server`
   - `.env.worker`
   - `.env.web`
   - `.env.k8s.apply`
3. Ignored generated deploy files:
   - `deploy/.generated/replica/metadata.env`
   - `deploy/.generated/replica/server.env`
   - `deploy/.generated/replica/web.env`
   - `deploy/.generated/replica/worker.env`
   - `deploy/.generated/replica/images.env`

### Why this fits this repo

- root `.env*` are already a repo-native config surface
- `deploy/.generated/replica/` is already how the newer deploy path expects metadata and env files
- `validation/run-replica-flow.mjs` already expects `deploy/.generated/replica/metadata.env`
- `.vp-task/` gives one place for wrappers, manifests, and restore info

### Wrapper strategy

Codex should be told to use clone-local wrapper commands first:

- `vp-redeploy`
  - build/push task platform images
  - apply task platform workloads
- `vp-validate`
  - run the full task validation harness
- `vp-status`
  - namespace-aware status checks
- `vp-runtime-logs`
  - fetch platform runtime logs and recent task evidence

The CLI should prepend `.vp-task/bin` to `PATH` for the Codex process so these feel native.

### Tracked file patching

Design target: no tracked-file patching inside the clone.

Required tracked repo changes should be made once in the main repo so that task-specific values can be supplied through env/generated files.

If implementation discovers one unavoidable tracked-file patch later:

- backup it to `.vp-task/backups/...`
- record it in the manifest
- restore it before publish
- fail publish if any manifest-backed patch remains unrestored

## Phase 3: Namespaced Runtime Provisioning

### Best repo-native runtime model

Do not bootstrap a new cluster per task.

Use the already-validated replica cluster as the shared substrate, then create task-scoped platform resources inside it.

### Recommended task-scoped namespaces

Use a task namespace prefix:

- platform namespace: `vp-task-<token>-platform`
- development namespace: `vp-task-<token>-development`
- testing namespace: `vp-task-<token>-testing`
- production namespace: `vp-task-<token>-production`

Minimal safe path for v1:

- create `platform` immediately
- create `development` lazily through worker/app deploy flow
- create `testing` and `production` lazily only if the run needs them

### Recommended task-scoped platform hosts

Because the replica cert covers `replica.vibesplatform.ai` and `*.replica.vibesplatform.ai`, hosts must remain single-label beneath `replica.vibesplatform.ai`.

Use:

- root host: `<token>.replica.vibesplatform.ai`
- web host: `app-<token>.replica.vibesplatform.ai`
- api host: `api-<token>.replica.vibesplatform.ai`

Do not use nested hosts like `api.<token>.replica.vibesplatform.ai`.

### Recommended project preview host strategy

Current worker host generation is `slug-environment-shortid.<domain>`.

For task isolation, add a tracked env-driven suffix such as `PROJECT_HOST_SUFFIX=<token>` so project hosts become:

- `slug-development-shortid-<token>.replica.vibesplatform.ai`

This stays single-label under the replica wildcard cert and avoids collisions with the main replica and other tasks.

### Existing deploy logic to reuse

Reuse:

- [`deploy/build-push.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/build-push.sh) for platform images
- [`deploy/apply-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/apply-platform.sh) for server/web/worker/redis
- [`infra/k8s/deploy.sh`](/Users/jccarlin/Documents/VibesPlatform/infra/k8s/deploy.sh) for customer app deploys
- worker-driven workspace and preview logic in [`worker/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/index.js)

### What must be added

Tracked changes:

- parameterize platform namespace and cluster-scoped bindings in `deploy/apply-platform.sh` and `deploy/k8s/platform/*`
- parameterize worker namespace calculation in [`worker/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/index.js)
- parameterize project host generation in [`worker/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/index.js)
- add task-specific DNS helper for exact root/app/api aliases

### Worker/background-service handling

Task platform still needs:

- `vibes-server`
- `vibes-web`
- `vibes-worker`
- `redis`

These can keep their in-namespace resource names.

Important cluster-scoped pitfall:

- `worker-deployer` and `vibes-admin-metrics-read` are currently cluster-scoped roles and bindings.
- `ClusterRoleBinding` names cannot be reused across multiple task platform instances.

Recommended fix:

- keep shared `ClusterRole` names stable
- create unique `ClusterRoleBinding` names per task instance, for example:
  - `worker-deployer-<token>`
  - `vibes-admin-metrics-read-<token>`

### Minimal safe provisioning path

1. Confirm replica metadata/envs exist and cluster is reachable.
2. Compute task token, hosts, namespaces, schema.
3. Generate task env files.
4. Build and push task platform images.
5. Apply task platform workloads into `vp-task-<token>-platform`.
6. Upsert exact Route53 aliases for task root/app/api hosts to the shared ALB.
7. Let worker create project/customer resources on demand inside task development namespace.

## Phase 4: DB and Schema Isolation

### Platform DB recommendation

Use schema-per-task inside the existing platform database.

This is feasible in this repo because:

- server and worker use one `DATABASE_URL`
- queries use unqualified table names
- migrations use unqualified DDL
- `schema_migrations` is unqualified and can live inside the task schema

### How to create the task schema

Create a schema before first deploy:

- schema name: `vp_task_<token>`

Then generate task `DATABASE_URL` values that force `search_path` to:

- `vp_task_<token>,public`

Do not alter the role globally. Put the schema selection in the task-specific connection string only.

### Migration behavior

Keep `RUN_MIGRATIONS=true` in task server env.

Expected behavior:

- platform tables are created in `vp_task_<token>`
- `schema_migrations` is created in `vp_task_<token>`
- `pgcrypto` extension remains db-level and `create extension if not exists` remains safe

### Customer app DB recommendation

Do not try to convert customer app DBs to schema-per-task.

Reason:

- current repo model is database-per-project-per-environment
- customer apps are arbitrary code and may bring their own migration assumptions
- the worker already knows how to create/drop full per-project DBs

Repo-native approach:

- task platform state uses a task schema
- validation-created projects continue to use full per-project DBs
- cleanup uses existing delete-project behavior plus direct verification

### Cleanup implications

Important repo fact:

- `init-project` currently creates all three customer DBs immediately:
  - development
  - testing
  - production

So the cleanup manifest must record:

- project id
- short id
- all expected DB names for that project

## Phase 5: Codex CLI Wrapper Strategy

### Existing Codex usage in this repo

The worker already has:

- [`worker/src/workspace-codex-runner.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/workspace-codex-runner.js)
- `runCodex` and `runCodexInWorkspace` in [`worker/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/index.js)

Important repo fact:

- current worker env synthesis still emits `--yolo`-style command templates
- local pinned Codex CLI in this repo is `codex-cli 0.104.0`
- local `codex exec --help` does not advertise `--yolo`

The internal task CLI should not blindly reuse the current worker command template.

### Recommended invocation

Use the repo-pinned binary:

- `./node_modules/.bin/codex`

Run non-interactively with:

- `exec`
- `--json`
- `-o <last-message-file>`
- `-C <cloneDir>`
- `--skip-git-repo-check`
- `-m gpt-5.4`
- `--sandbox danger-full-access`

Approval policy:

- first choice: top-level `-a never`
- fallback: `--dangerously-bypass-approvals-and-sandbox` if the installed CLI version rejects approval inheritance on `exec`

Reasoning effort:

- pass `-c 'reasoning.effort="xhigh"'`

This config key is an inference from OpenAI GPT-5.4 model docs, not from local CLI help, so implementation should version-check and fail loudly if the installed CLI rejects it.

### Wrapper prompt

Store the tracked template at:

- `scripts/agent-task/prompt-template.md`

Generate the run-specific prompt into:

- `.vp-task/prompt.md`

The prompt should explicitly state:

- current branch name
- do not switch branches
- do not commit or push
- use `vp-redeploy`, `vp-validate`, `vp-status`, `vp-runtime-logs`
- task manifest path
- timeout budget
- publish sanitation constraints

### Manifest exposure to Codex

Expose the task manifest in two ways:

- file: `.vp-task/manifest.json`
- env: `VP_TASK_MANIFEST=.vp-task/manifest.json`

### Timeout and process control

The internal CLI should enforce a hard runtime cutoff itself.

Recommended:

- default Codex runtime budget: 90 minutes
- send SIGTERM first
- capture final stdout/stderr
- always run final cleanup after timeout

### Captured artifacts

Preserve outside the clone:

- raw Codex JSONL stdout
- Codex stderr
- last agent message file
- wrapper prompt file
- run manifest
- deploy logs
- validation evidence
- sanitation report
- cleanup report

## Phase 6: Validation Strategy

### Baseline smoke before Codex edits

Run a task-platform smoke after the first task platform deploy and before handing control to Codex.

Use the existing replica harness as base and extend it so it can target:

- task API host
- task web host
- task platform namespace
- task project host suffix
- external evidence directory

Baseline smoke must prove:

1. platform `/health`
2. register user
3. create project
4. wait for project starter snapshot
5. create development task
6. wait for completion
7. wake workspace preview
8. verify preview marker
9. verify repo bundle download

### Post-Codex validation

After Codex edits and redeploy:

1. rerun the same end-to-end flow with a fresh user and fresh project
2. preserve evidence outside the clone
3. if the feature needs more checks, let Codex run those through wrapper commands and local repo commands

### Existing tooling to reuse

- [`validation/run-replica-flow.mjs`](/Users/jccarlin/Documents/VibesPlatform/validation/run-replica-flow.mjs)
- `/projects/:projectId/runtime-logs`
- [`scripts/status-check.sh`](/Users/jccarlin/Documents/VibesPlatform/scripts/status-check.sh)

### Required validation enhancements

Tracked changes should make the validation harness accept env overrides for:

- metadata env path
- evidence output directory
- platform namespace
- web ingress name
- project host suffix
- optional cleanup-after flag

### Cleanup verification in validation

This repo already has project deletion behavior in worker.

Validation should be extended, or the agent CLI should add a post-step, to verify:

1. `DELETE /projects/:projectId` succeeds
2. customer DBs for the validation project are gone
3. development workspace resources for the project are gone
4. task schema still contains only task-platform state until finalizer runs

The user account itself does not need a new delete API if the finalizer drops the entire task schema afterward.

## Phase 7: Publish Sanitation Strategy

### Always-generated and always-ignored

Tracked `.gitignore` additions should include:

- `.vp-task/`
- `.codex-last-message.txt`

Already ignored and reused:

- `.env`
- `.env.local`
- `.env.*`
- `deploy/.generated/`
- `validation/evidence/*`

### Publish gate

Before commit/push:

1. delete all generated task files from the clone
2. restore any manifest-backed tracked-file patches
3. run `git status --porcelain`
4. fail if any task-only tracked edits remain
5. fail if any forbidden task values appear in tracked diffs

### Forbidden pattern scan

Scan staged and unstaged tracked diffs for exact run-specific values:

- task token
- task platform namespace
- task development/testing/production namespaces
- task platform hosts
- task schema name
- project host suffix
- `.vp-task`
- `deploy/.generated/replica`
- run-specific validation emails
- any task-only credentials or generated URLs

Use exact manifest values, not generic regexes, so false positives stay manageable.

### Final diff check

Required publish checks:

- `git diff --check`
- `git status --porcelain` after generated-file deletion
- `git diff --name-only origin/<base>...HEAD` or equivalent worktree diff report
- forbidden-value scan against tracked changes only

The CLI, not Codex, should create the final commit and push.

## Phase 8: Cleanup and Finalizer Strategy

### Task-owned resources to record

Runtime-created resources should be explicitly recorded in the manifest:

1. platform resources
   - task platform namespace
   - exact root/app/api DNS aliases
   - clusterrolebinding names
2. DB resources
   - task platform schema
   - validation-created project DB names
3. image resources
   - server/web/worker image tags pushed for the task platform
4. validation-created app resources
   - project ids
   - project short ids
   - expected customer app namespaces/hosts
5. local resources
   - disposable clone path
   - generated overlay paths

### Cleanup order

Recommended order:

1. call project delete for every recorded validation project while task platform is still alive
2. verify customer DBs are dropped
3. delete task platform workloads and namespaces
4. delete task root/app/api Route53 aliases
5. delete task platform image tags from shared server/web/worker repos
6. drop task platform schema
7. delete local generated task files and disposable clone
8. keep artifacts and final reports

### Retry and idempotency

Every cleanup step should be:

- manifest-driven
- safe to rerun
- tolerant of not-found responses

If cleanup partially fails:

- preserve `cleanup-failed.json`
- preserve the manifest
- preserve exact remaining resource names
- exit non-zero

Do not infer owned resources at cleanup time from loose naming alone.

## Phase 9: Implementation Blueprint

### Tracked repo additions

Recommended tracked additions or edits:

1. New internal CLI
   - `scripts/agent-task/index.mjs`
   - `scripts/agent-task/lib/*.mjs`
   - `scripts/agent-task/prompt-template.md`
2. Make wrappers
   - [`Makefile`](/Users/jccarlin/Documents/VibesPlatform/Makefile)
3. Ignore rules
   - [`.gitignore`](/Users/jccarlin/Documents/VibesPlatform/.gitignore)
4. Platform deploy parameterization
   - [`deploy/apply-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/apply-platform.sh)
   - [`deploy/destroy-platform.sh`](/Users/jccarlin/Documents/VibesPlatform/deploy/destroy-platform.sh)
   - `deploy/k8s/platform/*.tpl`
   - `deploy/k8s/platform/*.yaml`
5. Worker namespace/host parameterization
   - [`worker/src/index.js`](/Users/jccarlin/Documents/VibesPlatform/worker/src/index.js)
6. Validation parameterization
   - [`validation/run-replica-flow.mjs`](/Users/jccarlin/Documents/VibesPlatform/validation/run-replica-flow.mjs)
7. Optional helper script
   - new task DNS helper, rather than overloading wildcard base DNS sync

### Clone-local generated files

Recommended clone-local generated layout:

```text
.vp-task/
  manifest.json
  cleanup.json
  prompt.md
  bin/
    vp-redeploy
    vp-validate
    vp-status
    vp-runtime-logs
  backups/
    ...only if tracked files are ever patched...

.env
.env.server
.env.worker
.env.web
.env.k8s.apply

deploy/.generated/replica/
  metadata.env
  server.env
  web.env
  worker.env
  images.env
```

### Runtime-created cluster and DB resources

Recommended manifest ownership model:

```json
{
  "runId": "",
  "taskToken": "",
  "featureBranch": "",
  "baseBranch": "",
  "clonePath": "",
  "artifactsDir": "",
  "cluster": {
    "context": "",
    "platformNamespace": "",
    "envNamespaces": {
      "development": "",
      "testing": "",
      "production": ""
    },
    "hosts": {
      "root": "",
      "app": "",
      "api": ""
    },
    "projectHostSuffix": "",
    "clusterRoleBindings": []
  },
  "database": {
    "platformDatabaseName": "",
    "platformSchema": "",
    "projects": []
  },
  "images": {
    "platform": [],
    "customerAppRepo": ""
  },
  "validation": {
    "runs": [],
    "users": [],
    "projects": []
  },
  "generatedPaths": [],
  "forbiddenPublishValues": [],
  "patchedTrackedFiles": []
}
```

### Preserved artifacts outside the clone

Use:

- `validation/evidence/agent-cli/<runId>/`

Recommended contents:

- `manifest.json`
- `codex/stdout.jsonl`
- `codex/stderr.log`
- `codex/last-message.txt`
- `deploy/pre-codex.log`
- `deploy/post-codex.log`
- `validation/baseline/*`
- `validation/post/*`
- `publish/sanitation-report.json`
- `cleanup/cleanup-report.json`

### Step-by-step implementation order

1. Parameterize platform/runtime namespace and host derivation in tracked code.
2. Add task platform schema creation/drop support and task `DATABASE_URL` generation.
3. Parameterize validation harness so it can target task hosts/namespaces and write evidence outside the clone.
4. Add task DNS helper for exact root/app/api aliases.
5. Add the internal Node CLI skeleton with `plan`, `run`, `cleanup`, and manifest writing.
6. Add clone-local overlay generation and wrapper commands.
7. Add publish sanitation gate.
8. Add finalizer and retryable cleanup.
9. Run end-to-end against a trivial change and verify:
   - clone creation
   - task platform deploy
   - user/project/task flow
   - delete-project cleanup
   - schema drop
   - branch commit/push

### Repo-specific risks and pitfalls

1. The newer replica deploy flow and the older Make deploy flow are not the same system.
   - The agent CLI should standardize on the newer replica-style scripts and expose wrappers.
2. Cluster-scoped RBAC names will collide unless bindings are made unique per task.
3. The current replica wildcard cert does not cover nested task subdomains.
   - project host suffix must live inside the single label, not as another DNS label.
4. `validation/run-replica-flow.mjs` is currently hardcoded to replica metadata path and `vibes-platform`.
5. `worker/src/index.js` hardcodes `vibes-development` in `workspaceNamespace()`.
6. Existing worker Codex templates still assume stale CLI flags.
7. Platform image cleanup does not exist today and must be added for task runs.
8. Project creation currently creates development/testing/production DB records and databases immediately.

### What to implement first vs later

Implement first:

- namespace and host parameterization
- task schema overlay
- validation override support
- internal CLI `run` + `cleanup`
- publish sanitation gate

Implement later:

- `plan` subcommand polish
- run resume/reattach ergonomics
- optional long-context Codex tuning such as model context window/auto-compact knobs
- richer artifact viewers

## Decision Summary

Recommended core architecture:

- build the internal CLI as repo-level Node `.mjs` under `scripts/agent-task/`
- reuse the validated replica cluster as the substrate
- isolate platform state with a task-specific schema in the shared platform database
- isolate runtime state with task-specific namespaces and single-label task hosts
- keep project preview hosts under the base replica domain by adding a host suffix inside the label
- generate clone-local envs, metadata, and wrappers so the clone tells one story
- avoid tracked-file patching inside the clone
- let the CLI, not Codex, own final commit/push and all cleanup
