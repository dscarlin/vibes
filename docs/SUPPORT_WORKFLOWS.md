# Support Workflows (MVP)

This runbook covers the minimum support flow you need before charging customers.

## 1) Support Intake

Capture the following in every report:
- Project name + environment (dev/test/prod)
- URL that failed
- Timestamp (local time + timezone)
- What action was attempted (deploy, run task, open app, etc.)
- Screenshot / error message

## 2) Quick Diagnostics Checklist

### A. Project Status
- Check if the environment is live / offline:
  - Admin UI → Projects / Environments
- If UI looks wrong, run:
  - `make status-check`

### B. Deployment Health
- Check latest build status:
  - Admin UI → Build status badges
- If failed, open logs:
  - Task logs (admin or UI) 
  - `kubectl -n vibes-development get pods -o wide` (dev)

### C. Health Check / CrashLoop
- If health check failed:
  - Confirm `PORT` is set or defaults to `3000`.
  - Confirm `HEALTHCHECK_PATH` is correct for the app.
  - Check pod logs:
    - `kubectl -n vibes-development logs deploy/<app-name> --tail 200`

### D. DNS / Routing
- If URL resolves but shows 502:
  - Confirm deployment exists in correct namespace.
  - Confirm service/ingress is present.
- If URL does not resolve:
  - Confirm Route53 record exists.
  - Confirm `AUTO_DNS` is enabled.

## 3) Customer Log Collection

If the customer can access the UI, request:
- Screenshot of the error
- Last 200 log lines (Task logs or App logs panel)

If customer cannot access UI:
- Collect logs via admin panel or kubectl:
  - `kubectl -n vibes-development logs deploy/<app-name> --tail 200`

## 4) Known Issues (MVP)

- `CrashLoopBackOff` after deploy: usually app start failure or missing env vars.
- `502 Bad Gateway`: service is not healthy or app not listening on `PORT`.
- `plan_*` errors: plan limits enforced; upgrade required.

## 5) Escalation

If you cannot resolve in 15–30 minutes:
- Ask for repo snapshot upload from the project.
- Reproduce with a fresh deploy in dev.
- Consider rolling back or scaling to zero.

## 6) Internal Notes

Add a short note to `docs/DEPLOYMENTS.md` for:
- Any changes to infra or core scripts.
- Any customer issue that indicates a platform gap.
