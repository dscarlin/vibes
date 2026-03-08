alter table environments
  add column if not exists live_since timestamptz;

create table if not exists runtime_usage (
  id serial primary key,
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null,
  month text not null,
  runtime_ms bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, environment, month)
);
