# RDS Backup + Restore Runbook

This runbook is for the **platform RDS instance** (vibes_platform) and is intended to be executed **before go‑live** and **quarterly thereafter**.

## 1) Automated Backups (Required)

1. Enable automated backups.
2. Set retention to **7–30 days** (pick based on your tolerance).
3. Set a backup window (off‑peak).
4. Enable **Deletion Protection**.
5. Ensure **Copy Tags to Snapshots** is enabled.

## 2) Manual Snapshot (Pre‑Change)

Create a manual snapshot before any production‑affecting change.

## 3) Restore Drill (Required Before Go‑Live)

**Goal:** Validate you can restore and read data.

1. Restore the latest snapshot to a **new** DB instance:
   - Name: `vibes-platform-restore-drill`
   - Same engine/version, same VPC/subnets/SGs.
   - Keep it private.
2. Wait for status `available`.
3. Connect and verify:
   - `select now();`
   - `select count(*) from users;`
4. Delete the restored instance after verification.

## 4) Review Checklist

- [ ] Retention set (days): ___
- [ ] Deletion protection enabled
- [ ] Copy tags to snapshots enabled
- [ ] Restore drill completed (date): ___

## 5) Helpful AWS CLI Commands (Templates)

**Describe instance backup settings**
```bash
aws rds describe-db-instances \
  --db-instance-identifier <DB_INSTANCE_ID> \
  --region <AWS_REGION> \
  --query "DBInstances[0].{BackupRetention:BackupRetentionPeriod,DeletionProtection:DeletionProtection,BackupWindow:PreferredBackupWindow,CopyTagsToSnapshots:CopyTagsToSnapshots}"
```

**List latest automated snapshot**
```bash
aws rds describe-db-snapshots \
  --db-instance-identifier <DB_INSTANCE_ID> \
  --snapshot-type automated \
  --region <AWS_REGION> \
  --query "reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:1].{SnapshotId:DBSnapshotIdentifier,Created:SnapshotCreateTime}"
```

**Restore from snapshot (template)**
```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier vibes-platform-restore-drill \
  --db-snapshot-identifier <SNAPSHOT_ID> \
  --db-subnet-group-name <SUBNET_GROUP> \
  --vpc-security-group-ids <SG_ID> \
  --no-publicly-accessible \
  --region <AWS_REGION>
```
