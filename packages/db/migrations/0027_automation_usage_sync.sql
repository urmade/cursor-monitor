-- Cadence sync of Cursor automation usage events (filtered-usage-events with
-- automationId: "*") plus Cloud Agents enrichment (target repo, duration).

create table if not exists automation_usage_events (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  cursor_organisation_id uuid not null
    references cursor_organisations(id) on delete cascade,
  event_fingerprint text not null,
  source text not null check (source in ('teams', 'organizations')),
  event_timestamp timestamptz not null,
  automation_id text not null,
  cloud_agent_id text,
  team_id integer,
  model text,
  kind text,
  charged_cents double precision,
  user_email text,
  service_account_id text,
  service_account_name text,
  target_repo text,
  duration_ms integer,
  raw_event jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cursor_organisation_id, event_fingerprint)
);

create index if not exists automation_usage_events_org_ts
  on automation_usage_events (org_id, event_timestamp desc);

create index if not exists automation_usage_events_automation
  on automation_usage_events (cursor_organisation_id, automation_id, event_timestamp desc);

create index if not exists automation_usage_events_agent
  on automation_usage_events (cloud_agent_id, event_timestamp desc)
  where cloud_agent_id is not null;

-- One row per (organisation, cloud agent) attributed to an automation.
create table if not exists automation_agent_runs (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  cursor_organisation_id uuid not null
    references cursor_organisations(id) on delete cascade,
  automation_id text not null,
  cloud_agent_id text not null,
  target_repo text,
  duration_ms integer,
  charged_cents_total double precision not null default 0,
  event_count integer not null default 0,
  first_event_at timestamptz,
  last_event_at timestamptz,
  agent_name text,
  latest_model text,
  source text not null check (source in ('teams', 'organizations')),
  enrichment_error text,
  raw_agent jsonb,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cursor_organisation_id, cloud_agent_id)
);

create index if not exists automation_agent_runs_org_last
  on automation_agent_runs (org_id, last_event_at desc);

create index if not exists automation_agent_runs_automation
  on automation_agent_runs (cursor_organisation_id, automation_id, last_event_at desc);

create index if not exists automation_agent_runs_repo
  on automation_agent_runs (target_repo, last_event_at desc)
  where target_repo is not null;

do $$
begin
  alter table automation_usage_events enable row level security;
exception
  when undefined_table then null;
end $$;

do $$
begin
  alter table automation_agent_runs enable row level security;
exception
  when undefined_table then null;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table automation_usage_events from anon;
    revoke all on table automation_agent_runs from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table automation_usage_events from authenticated;
    revoke all on table automation_agent_runs from authenticated;
  end if;
end $$;
