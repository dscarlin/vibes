# Pricing + Limits Policy (MVP)

Status: Draft (approved pricing + add-ons)
Last updated: 2026-03-07

This document defines the MVP pricing tiers, add-on pricing, and the intended plan limits. It also records implementation status so we can align product behavior with policy over time.

## Plans and Pricing (MVP)

### Starter — $39/mo
- Included projects: 1
- Environments: Development only
- Mobile builds: No
- Add-on project (Dev-only): $36/mo each

### Builder — $99/mo
- Included projects: 1
- Environments: Development + Testing
- Mobile builds: Yes
- Add-on project (Dev + Test): $89/mo each

### Business — $250/mo
- Included projects: 1
- Environments: Development + Testing + Production
- Mobile builds: Yes
- Add-on project (Dev + Test + Prod): $225/mo each

### Agency
- Deferred for MVP (planned for IAM / multi-user / orgs)

## Runtime Quotas (Current)

Monthly runtime quotas per plan + environment:
- Starter: Dev 60h
- Builder: Dev 100h, Test 60h
- Business: Dev 200h, Test 100h, Prod 750h

These values reflect current `.env.server` / `.env.worker` `RUNTIME_QUOTAS` and are used for scale-to-zero enforcement.

## Non-Runtime Limits (Proposed v1)

These limits protect variable AWS costs (build minutes, storage, bandwidth).

| Plan | Builds / month | Image storage | DB storage | Bandwidth / month |
| --- | --- | --- | --- | --- |
| Starter | 60 | 3 GB | 2 GB | 15 GB |
| Builder | 160 | 10 GB | 8 GB | 50 GB |
| Business | 500 | 40 GB | 40 GB | 250 GB |

Notes:
- “Image storage” is total container image storage per project.
- “DB storage” is per project.
- “Bandwidth” includes egress and load balancer traffic.

## Overage Pricing (Proposed v1)

If we enable overage billing (soft limits), these are the proposed rates:
- Build minutes: $0.03 / minute
- Image storage: $0.15 / GB-month
- DB storage: $0.20 / GB-month
- Bandwidth: $0.12 / GB

## Add-on Project Policy (MVP)

Each add-on project increases the project limit by 1 and includes the same per-project entitlements as the base plan tier (environments + runtime quota + non-runtime limits).

## Measurement & Billing Period

- Monthly usage resets on the first day of each month (UTC).
- Runtime hours are measured per environment.
- Builds are counted per deploy/build attempt.
- Storage and bandwidth are measured per project.

## Implementation Status (as of 2026-03-07)

Enforced today:
- Project count limit (1 for Starter/Builder/Business).
- Environment gating (Dev/Test/Prod by plan).
- Mobile gating (Builder/Business).
- Runtime quota enforcement and auto scale-to-zero.

Not yet enforced:
- Build count / build minutes caps.
- Per-project storage caps (ECR, DB storage).
- Bandwidth caps or overage billing.

## Next Steps

1. Decide if overage billing is enabled from day one or after launch.
2. Implement tracking for build minutes, storage, bandwidth.
3. Add per-project entitlements for add-on projects.
4. Introduce org/IAM before reintroducing an Agency plan.
