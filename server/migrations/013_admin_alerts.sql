create table if not exists admin_alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  level text not null default 'warning',
  message text not null,
  data jsonb not null default '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index if not exists admin_alerts_created_at_idx on admin_alerts (created_at desc);
create index if not exists admin_alerts_ack_idx on admin_alerts (acknowledged_at);
