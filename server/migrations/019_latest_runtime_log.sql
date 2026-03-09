alter table environments
  add column if not exists latest_runtime_log text not null default '';

alter table environments
  add column if not exists latest_runtime_log_updated_at timestamptz;

alter table environments
  add column if not exists latest_runtime_log_attempt_id uuid;
