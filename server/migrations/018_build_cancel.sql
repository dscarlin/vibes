alter table builds add column if not exists cancel_requested boolean not null default false;
alter table builds add column if not exists cancelled_at timestamptz;
