create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
