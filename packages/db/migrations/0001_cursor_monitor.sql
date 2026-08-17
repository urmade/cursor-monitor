create table if not exists monitor_hook_events (
  id uuid primary key,
  event_name text not null,
  conversation_id text,
  conversation_key text,
  generation_id text,
  repository_key text,
  repository_label text,
  git_branch text,
  workspace_root text,
  user_email text,
  model text,
  status text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  payload jsonb not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index if not exists monitor_hook_events_repository_received
  on monitor_hook_events (repository_key, received_at desc);
create index if not exists monitor_hook_events_conversation_received
  on monitor_hook_events (conversation_key, received_at desc);
create unique index if not exists monitor_hook_events_generation_event
  on monitor_hook_events (generation_id, event_name)
  where generation_id is not null;

create table if not exists monitor_team_usage_events (
  fingerprint text primary key,
  occurred_at timestamptz not null,
  conversation_id text,
  conversation_key text,
  user_email text,
  model text,
  kind text,
  team_id integer,
  charged_cents double precision,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists monitor_team_usage_conversation
  on monitor_team_usage_events (conversation_key, occurred_at desc);
create index if not exists monitor_team_usage_occurred
  on monitor_team_usage_events (occurred_at desc);

create table if not exists monitor_repository_preferences (
  repository_key text primary key,
  display_name text,
  merged_into_key text,
  updated_at timestamptz not null default now(),
  constraint monitor_repository_not_self_merged check (
    merged_into_key is null or lower(btrim(repository_key)) <> lower(btrim(merged_into_key))
  )
);

create index if not exists monitor_repository_preferences_merged
  on monitor_repository_preferences (merged_into_key)
  where merged_into_key is not null;

create table if not exists monitor_conversation_preferences (
  conversation_key text primary key,
  display_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists monitor_branch_preferences (
  repository_key text not null,
  branch_key text not null,
  display_name text not null,
  updated_at timestamptz not null default now(),
  constraint monitor_branch_preferences_pk primary key (repository_key, branch_key)
);

create table if not exists monitor_sync_runs (
  id uuid primary key,
  source text not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  fetched_count integer not null default 0,
  inserted_count integer not null default 0,
  pages integer not null default 0,
  truncated boolean not null default false,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists monitor_sync_runs_started
  on monitor_sync_runs (started_at desc);

create table if not exists monitor_sync_locks (
  source text primary key,
  owner_id uuid not null,
  expires_at timestamptz not null
);

alter table monitor_hook_events enable row level security;
alter table monitor_team_usage_events enable row level security;
alter table monitor_repository_preferences enable row level security;
alter table monitor_conversation_preferences enable row level security;
alter table monitor_branch_preferences enable row level security;
alter table monitor_sync_runs enable row level security;
alter table monitor_sync_locks enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'monitor_hook_events',
    'monitor_team_usage_events',
    'monitor_repository_preferences',
    'monitor_conversation_preferences',
    'monitor_branch_preferences',
    'monitor_sync_runs',
    'monitor_sync_locks'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon', table_name);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %I from authenticated', table_name);
    end if;
  end loop;
end $$;
