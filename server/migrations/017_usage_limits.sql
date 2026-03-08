create index if not exists builds_project_created_at_idx on builds (project_id, created_at);

create table if not exists bandwidth_usage (
  id serial primary key,
  project_id uuid not null references projects(id) on delete cascade,
  month text not null,
  bytes_out bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (project_id, month)
);

create table if not exists bandwidth_log_ingest (
  id serial primary key,
  s3_key text not null unique,
  processed_at timestamptz not null default now()
);
