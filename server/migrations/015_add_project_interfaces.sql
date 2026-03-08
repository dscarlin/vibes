alter table projects add column if not exists interface_web boolean not null default true;
alter table projects add column if not exists interface_mobile boolean not null default false;
alter table projects add column if not exists mobile_stack_type text not null default 'expo';
