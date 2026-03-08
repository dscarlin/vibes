#!/usr/bin/env sh
set -eu

# Configure RDS backup settings for a DB instance.
# Usage:
#   DB_INSTANCE_ID=your-db-id AWS_REGION=us-east-1 \
#   BACKUP_RETENTION_DAYS=14 DELETION_PROTECTION=true COPY_TAGS_TO_SNAPSHOT=true \
#   APPLY_IMMEDIATELY=false BACKUP_WINDOW=03:00-04:00 \
#   CREATE_SNAPSHOT=true \
#   ./scripts/aws/rds-backup-plan.sh

DB_INSTANCE_ID="${DB_INSTANCE_ID:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
BACKUP_WINDOW="${BACKUP_WINDOW:-}"
DELETION_PROTECTION="${DELETION_PROTECTION:-true}"
COPY_TAGS_TO_SNAPSHOT="${COPY_TAGS_TO_SNAPSHOT:-true}"
APPLY_IMMEDIATELY="${APPLY_IMMEDIATELY:-false}"
CREATE_SNAPSHOT="${CREATE_SNAPSHOT:-false}"
SNAPSHOT_ID="${SNAPSHOT_ID:-}"

if [ -z "$DB_INSTANCE_ID" ]; then
  echo "DB_INSTANCE_ID is required" >&2
  exit 1
fi

bool_flag() {
  val="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  if [ "$val" = "true" ] || [ "$val" = "1" ] || [ "$val" = "yes" ]; then
    echo "true"
  else
    echo "false"
  fi
}

args="--db-instance-identifier $DB_INSTANCE_ID --backup-retention-period $BACKUP_RETENTION_DAYS"

if [ -n "$BACKUP_WINDOW" ]; then
  args="$args --preferred-backup-window $BACKUP_WINDOW"
fi

if [ "$(bool_flag "$DELETION_PROTECTION")" = "true" ]; then
  args="$args --deletion-protection"
else
  args="$args --no-deletion-protection"
fi

if [ "$(bool_flag "$COPY_TAGS_TO_SNAPSHOT")" = "true" ]; then
  args="$args --copy-tags-to-snapshot"
else
  args="$args --no-copy-tags-to-snapshot"
fi

if [ "$(bool_flag "$APPLY_IMMEDIATELY")" = "true" ]; then
  args="$args --apply-immediately"
fi

echo "Updating backup settings for $DB_INSTANCE_ID in $AWS_REGION..."
aws rds modify-db-instance $args --region "$AWS_REGION" >/dev/null

if [ "$(bool_flag "$CREATE_SNAPSHOT")" = "true" ]; then
  if [ -z "$SNAPSHOT_ID" ]; then
    SNAPSHOT_ID="${DB_INSTANCE_ID}-manual-$(date -u +%Y%m%d%H%M%S)"
  fi
  echo "Creating manual snapshot $SNAPSHOT_ID..."
  aws rds create-db-snapshot \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --db-snapshot-identifier "$SNAPSHOT_ID" \
    --region "$AWS_REGION" >/dev/null
fi

echo "Current backup settings:"
aws rds describe-db-instances \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --region "$AWS_REGION" \
  --query "DBInstances[0].{BackupRetention:BackupRetentionPeriod,DeletionProtection:DeletionProtection,BackupWindow:PreferredBackupWindow,CopyTagsToSnapshots:CopyTagsToSnapshots}" \
  --output table
