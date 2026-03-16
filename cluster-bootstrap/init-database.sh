#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
. "$REPO_ROOT/scripts/replica/lib.sh"

require_cmd kubectl aws

prepare_replica_dirs
write_backend_files
terraform_remote_init "$LAYER1_DIR" "$BACKEND_DIR/layer1.backend.hcl"
update_kubeconfig_for_replica

DB_HOST="$(layer1_output_raw db_host)"
DB_MASTER_USERNAME="$(layer1_output_raw db_master_username)"
DB_MASTER_PASSWORD="$(layer1_output_raw db_master_password)"
PLATFORM_DB_NAME="$(layer1_output_raw platform_database_name)"
PLATFORM_DB_USERNAME="$(layer1_output_raw platform_database_username)"
PLATFORM_DB_PASSWORD="$(layer1_output_raw platform_database_password)"
CUSTOMER_DB_ADMIN_USERNAME="$(layer1_output_raw customer_db_admin_username)"
CUSTOMER_DB_ADMIN_PASSWORD="$(layer1_output_raw customer_db_admin_password)"

POD_NAME="replica-db-bootstrap"
NAMESPACE="vibes-platform"

cleanup_bootstrap_pod() {
  kubectl_retry -n "$NAMESPACE" delete pod "$POD_NAME" --ignore-not-found --wait=false --grace-period=0 --force >/dev/null 2>&1 || true
}

kubectl_retry create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl_retry apply -f - >/dev/null
cleanup_bootstrap_pod
trap 'cleanup_bootstrap_pod' EXIT
kubectl_retry -n "$NAMESPACE" run "$POD_NAME" \
  --image=postgres:16 \
  --restart=Never \
  --env="PGHOST=$DB_HOST" \
  --env="PGUSER=$DB_MASTER_USERNAME" \
  --env="PGPASSWORD=$DB_MASTER_PASSWORD" \
  --env="PGSSLMODE=require" \
  --dry-run=client -o yaml \
  --command -- sleep 600 | kubectl_retry apply -f - >/dev/null

kubectl_retry -n "$NAMESPACE" wait --for=condition=Ready "pod/$POD_NAME" --timeout=180s >/dev/null

kubectl_retry -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc "psql -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PLATFORM_DB_USERNAME}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${PLATFORM_DB_USERNAME}', '${PLATFORM_DB_PASSWORD}');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${PLATFORM_DB_USERNAME}', '${PLATFORM_DB_PASSWORD}');
  END IF;
END
\$\$;

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CUSTOMER_DB_ADMIN_USERNAME}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN CREATEDB PASSWORD %L', '${CUSTOMER_DB_ADMIN_USERNAME}', '${CUSTOMER_DB_ADMIN_PASSWORD}');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN CREATEDB PASSWORD %L', '${CUSTOMER_DB_ADMIN_USERNAME}', '${CUSTOMER_DB_ADMIN_PASSWORD}');
  END IF;
END
\$\$;

SELECT format('CREATE DATABASE %I OWNER %I', '${PLATFORM_DB_NAME}', '${PLATFORM_DB_USERNAME}')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${PLATFORM_DB_NAME}')
\gexec
SQL"

kubectl_retry -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc "psql -v ON_ERROR_STOP=1 -d '${PLATFORM_DB_NAME}' <<'SQL'
ALTER DATABASE ${PLATFORM_DB_NAME} OWNER TO ${PLATFORM_DB_USERNAME};
GRANT ALL PRIVILEGES ON DATABASE ${PLATFORM_DB_NAME} TO ${PLATFORM_DB_USERNAME};
ALTER SCHEMA public OWNER TO ${PLATFORM_DB_USERNAME};
GRANT ALL ON SCHEMA public TO ${PLATFORM_DB_USERNAME};
SQL"

cleanup_bootstrap_pod
trap - EXIT
log "Replica database bootstrap completed"
