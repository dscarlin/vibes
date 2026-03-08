alter table users
  add column if not exists plan text not null default 'starter';
