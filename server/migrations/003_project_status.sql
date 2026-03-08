alter table projects add column if not exists snapshot_status text not null default 'pending';
