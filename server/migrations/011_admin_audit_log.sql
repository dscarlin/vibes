create table if not exists admin_audit_log (
  id serial primary key,
  action text not null,
  admin_key_fingerprint text,
  ip text,
  user_agent text,
  path text,
  method text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_at_idx on admin_audit_log (created_at);
