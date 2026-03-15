alter table project_workspaces
  add column if not exists selected_mode text;

update project_workspaces
   set selected_mode = coalesce(selected_mode, preview_mode, 'verified')
 where selected_mode is null;

alter table project_workspaces
  alter column selected_mode set default 'verified';

update project_workspaces
   set selected_mode = 'verified'
 where selected_mode is null;

alter table project_workspaces
  alter column selected_mode set not null;

alter table project_workspaces
  add column if not exists selected_task_id uuid references tasks(id) on delete set null;

alter table project_workspaces
  add column if not exists selected_commit_sha text;

update project_workspaces
   set selected_commit_sha = coalesce(selected_commit_sha, current_commit_sha, last_verified_commit_sha)
 where selected_commit_sha is null;

alter table project_workspaces
  add column if not exists live_task_id uuid references tasks(id) on delete set null;

alter table project_workspaces
  add column if not exists live_commit_sha text;

update project_workspaces
   set live_commit_sha = coalesce(
     live_commit_sha,
     case
       when preview_mode = 'workspace' then current_commit_sha
       else last_verified_commit_sha
     end
   )
 where live_commit_sha is null;

alter table project_workspaces
  add column if not exists full_build_image_ref text;

alter table project_workspaces
  add column if not exists full_build_commit_sha text;

alter table project_workspaces
  add column if not exists full_build_cache_key text;

alter table project_workspaces
  add column if not exists full_build_built_at timestamptz;

create index if not exists project_workspaces_selected_task_idx
  on project_workspaces(selected_task_id);

create index if not exists project_workspaces_live_task_idx
  on project_workspaces(live_task_id);
