-- Phase 0 spike schema (p0.spike). Disposable — dropped in step 0.9.

create table if not exists schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists spike_tickets (
  id            uuid primary key,
  title         text        not null,
  body          text        not null default '',
  labels        text[]      not null default '{}',
  created_at    timestamptz not null default now()
);

create table if not exists spike_runs (
  id                uuid primary key,
  ticket_id         uuid        not null references spike_tickets(id),
  adapter           text        not null check (adapter in ('cloud_agent','automation_webhook')),
  external_agent_id text,
  external_run_id   text,
  nonce             text        not null,
  status            text        not null,
  launched_at       timestamptz not null default now(),
  terminal_at       timestamptz,
  duration_ms       integer,
  tokens            jsonb,
  raw_last_poll     jsonb,
  error             text
);

create table if not exists spike_reports (
  id          uuid primary key,
  ticket_id   uuid        not null references spike_tickets(id),
  run_nonce   text,
  body        jsonb       not null,
  created_at  timestamptz not null default now()
);

create table if not exists spike_run_tokens (
  token_hash  text primary key,
  run_id      uuid        not null references spike_runs(id),
  ticket_id   uuid        not null references spike_tickets(id),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create table if not exists spike_meta (
  key         text primary key,
  value       text        not null,
  updated_at  timestamptz not null default now()
);

-- RLS as defence in depth: enable with no permissive policies.
alter table spike_tickets enable row level security;
alter table spike_runs enable row level security;
alter table spike_reports enable row level security;
alter table spike_run_tokens enable row level security;
alter table spike_meta enable row level security;

-- Revoke anon/authenticated if those roles exist (Supabase).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table spike_tickets from anon;
    revoke all on table spike_runs from anon;
    revoke all on table spike_reports from anon;
    revoke all on table spike_run_tokens from anon;
    revoke all on table spike_meta from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table spike_tickets from authenticated;
    revoke all on table spike_runs from authenticated;
    revoke all on table spike_reports from authenticated;
    revoke all on table spike_run_tokens from authenticated;
    revoke all on table spike_meta from authenticated;
  end if;
exception
  when undefined_table then null;
  when undefined_object then null;
end $$;
