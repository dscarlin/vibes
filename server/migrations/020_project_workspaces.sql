create table if not exists project_workspaces (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null,
  pvc_name text not null,
  workspace_pod_name text,
  service_name text,
  preview_port integer,
  install_command text,
  preview_command text,
  lockfile_hash text,
  state text not null default 'sleeping',
  preview_mode text not null default 'verified',
  current_commit_sha text,
  last_verified_commit_sha text,
  workspace_dirty boolean not null default false,
  last_preview_heartbeat_at timestamptz,
  idle_expires_at timestamptz,
  snapshot_s3_key text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, environment)
);

create index if not exists project_workspaces_project_id_idx
  on project_workspaces(project_id);

create index if not exists project_workspaces_state_idx
  on project_workspaces(state);
