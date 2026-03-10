# K8s Add-ons

## Worker Deployment (IRSA)

1) Ensure IRSA is created (Terraform output `worker_irsa_role_arn`).
2) Update `infra/k8s/worker-service-account.yaml` with the role ARN.
3) Create/update the worker secret, then apply the deployment:

```
WORKER_ENV_FILE=./.env.worker ./infra/k8s/worker-secret-apply.sh

export WORKER_IMAGE=... 
./infra/k8s/worker-apply.sh
```

Required env vars in the secret file:
- `DATABASE_URL`
- `CUSTOMER_DB_ADMIN_URL`
- `CUSTOMER_DB_HOST`
- `CUSTOMER_DB_USER`
- `CUSTOMER_DB_PASSWORD`
- `CUSTOMER_DB_PORT`
- `CUSTOMER_DB_SSLMODE`
- `REDIS_HOST`
- `REDIS_PORT`
- `STARTER_REPO_URL`
- `STARTER_REPO_REF`
- `GIT_TOKEN`
- `SERVER_SOCKET_URL`
- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `ECR_REPO`
- `DEV_DEPLOY_COMMAND`
- `TEST_DEPLOY_COMMAND`
- `PROD_DEPLOY_COMMAND`
- `DEV_DELETE_COMMAND`
- `TEST_DELETE_COMMAND`
- `PROD_DELETE_COMMAND`
- `DOMAIN`
- `HEALTHCHECK_PATH`
- `HEALTHCHECK_TIMEOUT_MS`
- `HEALTHCHECK_INTERVAL_MS`

Note: `WORKER_IMAGE` is still passed at apply time.
Optional: `APP_DOMAIN` to force customer app hosts (for example `vibesplatform.ai`) when `DOMAIN` points at API (`api.vibesplatform.ai`).

## One-Time Stale DNS Cleanup

Use `infra/k8s/stale-dns-sweep.sh` to detect and optionally delete stale Route53 `A` records for app hosts.

Dry-run:

```
DOMAIN=vibesplatform.ai ./infra/k8s/stale-dns-sweep.sh dry-run
```

Apply:

```
DOMAIN=vibesplatform.ai ./infra/k8s/stale-dns-sweep.sh apply
```

Optional:
- `ROUTE53_HOSTED_ZONE_ID` to skip hosted-zone lookup.
- `KEEP_HOSTS` (comma-separated) to protect specific hosts.
- `INCLUDE_NON_PROJECT_RECORDS=true` to include non project-pattern hosts.
