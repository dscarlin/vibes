create table if not exists database_console_audit (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null,
  action text not null,
  schema_name text,
  object_name text,
  query_hash text,
  query_preview text,
  success boolean not null default true,
  duration_ms integer not null default 0,
  row_count integer,
  error_code text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists database_console_audit_project_env_created_idx
  on database_console_audit (project_id, environment, created_at desc);

create index if not exists database_console_audit_user_created_idx
  on database_console_audit (user_id, created_at desc);
