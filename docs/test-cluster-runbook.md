# Test Replica Runbook

## Prerequisites
- AWS CLI authenticated to account `897297231794`
- Terraform installed or Docker available for the bundled Terraform wrapper fallback
- `kubectl`, `helm`, `docker`, `git`, and `node` installed
- Replica secrets can be seeded automatically from the current local env files:
  - `make replica-seed-secrets-plan`
  - `make replica-seed-secrets`
- Secret sources:
  - `.env.server`
  - `.env.worker`
  - `.env.web`
- Secrets Manager targets:
  - `/vibes/test-replica/server`
  - `/vibes/test-replica/web`
  - `/vibes/test-replica/worker`

## Create / Apply

### Dry run
```sh
make replica-plan
```

### Apply
```sh
make replica-up
```

This workflow performs:
1. Remote-state bootstrap apply
2. Layer 1 Terraform apply
3. Layer 2 Terraform apply
4. Database bootstrap for platform and customer DB roles
5. Runtime secret sync from Secrets Manager
6. Server, web, worker, and Redis build/push
7. Platform deployment to the replica cluster
8. Base DNS sync for replica public hosts
9. Automated end-to-end validation

## Outputs To Capture
- Terraform outputs from Layer 1 and Layer 2
- Replica URLs
  - `https://replica.vibesplatform.ai`
  - `https://app.replica.vibesplatform.ai`
  - `https://api.replica.vibesplatform.ai`
- Validation evidence directory under `validation/evidence/`

## Manual Validation Checklist
- Open `https://replica.vibesplatform.ai` and confirm the web app loads.
- Log in with the generated validation user from the evidence bundle.
- Open the created validation project.
- Confirm Development preview resolves on the expected replica subdomain.
- Open the preview and confirm the validation marker is visible.
- Download the repo through the UI and verify the bundle exists.
- Confirm worker, server, and Redis are healthy:
  - `kubectl -n vibes-platform get pods`
- Confirm workspace resources are isolated to replica namespaces only.

## Where To Find Runtime Inputs
- Layer 1 Terraform outputs:
  - `scripts/replica/terraformw.sh -chdir=infra/envs/test-replica/layer1 output`
- Layer 2 Terraform outputs:
  - `scripts/replica/terraformw.sh -chdir=infra/envs/test-replica/layer2 output`
- Validation evidence:
  - `validation/evidence/<timestamp>/summary.json`

## Common Troubleshooting
- Missing secrets:
  - Check `aws secretsmanager get-secret-value --secret-id /vibes/test-replica/server`
- ALB controller issues:
  - `kubectl -n kube-system logs deploy/aws-load-balancer-controller`
- Platform pods unhealthy:
  - `kubectl -n vibes-platform logs deploy/vibes-server`
  - `kubectl -n vibes-platform logs deploy/vibes-worker`
- Preview issues:
  - `kubectl -n vibes-development get pods,svc,ingress,pvc`
  - API runtime logs endpoint for the project
