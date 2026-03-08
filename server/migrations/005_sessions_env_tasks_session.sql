alter table sessions add column if not exists environment text not null default 'development';
alter table tasks add column if not exists session_id uuid references sessions(id) on delete set null;
