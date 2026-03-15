alter table projects
  add column if not exists repo_bundle_blob bytea;

alter table projects
  add column if not exists repo_bundle_updated_at timestamptz;
