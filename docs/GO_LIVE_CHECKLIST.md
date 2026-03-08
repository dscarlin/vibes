# Go-Live Checklist

This checklist is scoped to the current VibesPlatform stack and focuses on the minimum needed to charge customers. Each item is actionable and maps to existing tooling.

## Status (2026-03-07)

### Launch-Blocking
1. Scale-to-zero timers (dev/test): **Set; RBAC updated to allow deployments/scale (verified via can-i, no new Forbidden logs)**
2. Health check correctness: **Correct**
3. Resource limits (noisy neighbor protection): **Set**
4. Customer nodegroup isolation: **Verified (customer deploy scheduled on customer node after RBAC fix)**
5. Secrets only in Kubernetes: **Done (no tracked `.env*`; k8s secrets present)**
6. Status accuracy (UI vs reality): **Checked; reconciled (dev shows 11 offline, no live replicas)**
7. Login + billing gate: **Verified (project limit, env gating, mobile gating, runtime quota)**

Notes (2026-03-07): All `vibes-development` deployments were scaled to 0. Customer nodegroup isolation verified after RBAC update (deploy scheduled on customer node). Manually set 5 dev environments to `offline` after scale-down; recheck UI/pod reconciliation after some app usage. Plan gate verification done via test user (starter/builder/business); runtime quota response showed starter limit_hours=20 (verify desired prod quotas).

### High Priority (Launch-Ready)
7. RDS backups + restore test: **Deferred**
8. Observability: **Verified access to worker/server logs; worker logs show RBAC issue on scale-to-zero**
9. Billing enforcement: **Reviewed: plan gates enforced; manual plan changes only; no auto-stop on plan downgrade**
10. Desktop signing: **Deferred**
11. Data integrity checks: **Checked; found 2 envs where `deployed_commit` != latest live build commit (Blabber, Recipe_Website_Simple_Elegance‑V1.0). Also found legacy live builds with null `ref_commit` (11 rows). Needs reconciliation/backfill.**
12. Security essentials: **In progress (worker IRSA tightened: removed ECR PowerUser, scoped Route53 changes to hosted zone, ECR token limited; public rate limits added to /health, /downloads/desktop, /admin; still need credential rotation)**
13. Support workflows: **Done (docs/SUPPORT_WORKFLOWS.md)**

### Post-Launch
11. Autoscaling policies: **Not done**
12. Retention policy for snapshots and artifacts: **Not done**
13. Audit trail exports: **Not done**

## Launch-Blocking

1. Scale-to-zero timers (dev/test)
   - Confirm env vars are set:
     - `DEV_SCALE_TO_ZERO_AFTER_MS=900000`
     - `TEST_SCALE_TO_ZERO_AFTER_MS=10800000`
     - `SCALE_TO_ZERO_INTERVAL_MS=60000`
   - Deploy worker:
     - `make deploy-all`

2. Health check correctness
   - Ensure the app health endpoint is correct for your apps.
   - Env:
     - `HEALTHCHECK_PATH=/` (or `/health` if apps expose it)
     - `HEALTHCHECK_TIMEOUT_MS=300000`
   - Deploy:
     - `make deploy-all`

3. Resource limits (noisy neighbor protection)
   - Ensure per-environment overrides exist in `.env.worker`.
   - Deploy:
     - `make deploy-all`

4. Customer nodegroup isolation
   - `CUSTOMER_NODEGROUP_ENABLED=true`
   - Label/taint customer nodes:
     - `kubectl label node <node> nodegroup=customer`
     - `kubectl taint node <node> nodegroup=customer:NoSchedule`
   - Verify placement:
     - `kubectl -n vibes-development get pods -o wide`

5. Secrets only in Kubernetes
   - Confirm `.env.*` are not committed or exposed to users.
   - Deploy secrets:
     - `make deploy-all`

6. Status accuracy (UI vs reality)
   - Run status checks:
     - `make status-check`
   - Compare UI build status with cluster deployment/pod state.

7. Login + billing gate
   - Ensure only paid customers can access paid environments.
   - Verify plan limits are enforced (projects, envs, runtime).
   - Confirm overage behavior (block, throttle, or charge).

## High Priority (Launch-Ready)

7. RDS backups + restore test
   - Enable backup retention and verify restore process.

8. Observability
   - Ensure you can quickly access worker/server logs.

9. Billing enforcement
   - Enforce plan limits (projects, envs, runtime).
   - Verify ALB access log ingest updates `bandwidth_usage` and caps enforce.

10. Desktop signing
   - Sign and notarize macOS builds before distributing broadly.

11. Data integrity checks
   - Verify snapshots and deployed commits align.
   - Ensure deployments never roll back to stale commits.

12. Security essentials
   - Rotate shared credentials and ensure least-privilege IAM.
   - Confirm secrets never land in client logs or snapshots.
   - Add basic rate limits on public APIs.

13. Support workflows
   - Document “known issues” and recommended fixes.
   - Provide a consistent way to gather customer logs.

## Post-Launch

11. Autoscaling policies
12. Retention policy for snapshots and artifacts
13. Audit trail exports

## Expanded Readiness Checklist

### Product/UX
- First‑project onboarding is deterministic with clear errors.
- “Create project” and “Run task” have success + failure states.
- Desktop: login, project list, and delete flow update live without restart.
- Mobile preview (iOS/Android) messages are actionable and accurate.

### Reliability
- Build retries are bounded and do not block the queue.
- Stuck build reconciliation doesn’t mark successful builds as failed.
- Health checks are validated per stack type (React, Next, Expo, etc.).
- App ports honor `PORT` env var or default to 3000.

### Resource Isolation
- Per‑env CPU/memory limits are set (dev/test/prod).
- Customer workloads are scheduled to customer nodegroup only.
- Platform services are isolated from customer workloads.

### Observability & Ops
- Worker logs show deployment start/finish/healthcheck outcome.
- Server logs show API errors with clear context.
- Metrics for build duration, queue length, failure rate.
- Alert when queue stalls or error rate spikes.

### Backups & Recovery
- Automated RDS backups enabled with tested restore.
- Snapshot blob recovery tested.
- Document RPO/RTO (even if minimal).

### Security
- API auth enforced for all write operations.
- Tokens are rotated and stored securely.
- DNS/SSL records are correct and valid.

### Billing & Limits
- Plans define:
  - Max projects
  - Max envs
  - Runtime limits (scale‑to‑zero policy)
  - Storage limits
- Overages clearly handled.

### Pricing & SLA (Draft – confirm before launch)
The numbers below reflect the bundle‑based plan approach you want.

**Proposed Plans**
| Segment | Plan | Monthly Price | Projects | Environments | Includes |
|---|---|---:|---:|---|---|
| Indie | Starter | $39 | 1 | Dev only | Scale‑to‑zero, AI credits sold separately |
| Indie | Builder | $99 | 1 | Dev + Test | Mobile builds enabled, better uptime + faster deploy |
| Small Business | Business | $199–$249 | 1 | Dev + Test + Prod | Mobile builds + deployment, better support + basic uptime guarantees |
| Agency | Agency | $499–$999 | 5–10 | Dev + Test + Prod per project | Priority support, higher limits + data tier |

**Add‑Ons**
| Add‑On | Price |
|---|---:|
| Extra project | $30–$60/mo |
| Production tier (higher CPU/mem) | $50–$200/mo |
| Additional mobile builds/release | $10–$20/mo |
| AI credits | cost + 15–30% margin |

**SLA Targets (Draft)**
| Metric | Target |
|---|---|
| API availability | 99.5% |
| Dev deploy success | >95% |
| Time to first byte (healthy app) | <2s |
| Support response (email) | 1–2 business days |

**Why this fits buyers**
- Indie price is accessible but not bargain‑basement.
- Small business pricing matches “no‑DevOps + reliable pipeline” value.
- Agencies expect higher pricing if you reduce ops burden.

### Desktop Distribution
- Mac builds are signed and notarized.
- Desktop download URL is correct for prod domain.
- Update flow is documented (manual or auto‑update).

### Legal & Policy
- Terms of service + privacy policy published.
- Data retention and deletion policy defined.

### Support & Ops
- “How to report a bug” guide exists.
- Internal runbooks for:
  - build failure
  - pod crash loops
  - deploy stuck
  - bad DNS/SSL

### Post‑Launch Scaling
- Node autoscaler configured.
- HPA for platform services.
- Dedicated nodegroup for production customers (optional).
