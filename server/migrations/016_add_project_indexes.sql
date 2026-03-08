create index if not exists projects_owner_id_idx on projects(owner_id);
create index if not exists environments_project_id_idx on environments(project_id);
create index if not exists tasks_project_id_idx on tasks(project_id);
create index if not exists sessions_project_id_idx on sessions(project_id);
create index if not exists builds_project_id_idx on builds(project_id);
