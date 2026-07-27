-- Phase 1: durable job queue, feature flags, cron meta, RLS lockdown.

create table jobs (
  id uuid primary key,
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','running','done','failed','dead')),
  priority integer not null default 0,
  run_after timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_claim on jobs (status, run_after) where status = 'pending';
create index jobs_status_updated on jobs (status, updated_at);

create table feature_flags (
  key text primary key,
  enabled boolean not null default false,
  enabled_for_project_ids uuid[] not null default '{}',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table app_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Defence in depth: enable RLS with no permissive policies; revoke API roles.
do $$
declare
  t text;
begin
  foreach t in array array[
    'orgs','users','projects','project_members','stages','labels',
    'work_items','work_item_labels','spec_versions','status_overrides',
    'stage_instances','transitions','events','jobs','feature_flags','app_meta'
  ]
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
  end if;
end $$;

insert into feature_flags (key, enabled) values
  ('p1.projects', true),
  ('p1.workitems', true),
  ('p1.specs', true)
on conflict (key) do nothing;
