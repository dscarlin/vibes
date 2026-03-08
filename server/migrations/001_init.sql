create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  short_id text not null,
  snapshot_blob bytea,
  created_at timestamptz not null default now()
);

create table if not exists environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  env_vars jsonb not null default '{}',
  deployed_commit text,
  build_status text not null default 'offline',
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null,
  prompt text not null,
  status text not null,
  codex_output text,
  commit_hash text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  message text not null,
  merge_commit text,
  created_at timestamptz not null default now()
);

create table if not exists builds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null,
  ref_commit text,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
