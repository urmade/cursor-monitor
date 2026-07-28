-- Phase 6: attention inbox projection, reconciliation, notifications.
-- Renumbered from 0014_attention → 0016_attention (merge hop 2). Idempotent for
-- databases that already applied the old filename on preview.

create table if not exists attention_items (
  id uuid primary key,
  project_id uuid not null references projects(id),
  work_item_id uuid not null references work_items(id),
  kind text not null check (kind in (
    'blocking_question','pending_approval','budget_block','run_failed',
    'run_completed_no_report','loop_escalation','external_block'
  )),
  source_type text not null,
  source_id uuid not null,
  title text not null,
  why text not null,
  asked_of text not null default 'anyone' check (asked_of in ('anyone','maintainer','owner')),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  score integer not null default 0,
  score_explain jsonb not null default '{}',
  actions jsonb not null default '[]',
  snoozed_until timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by jsonb,
  resolution text
);

-- Bring a pre-renumber attention_items up to the current shape.
alter table attention_items
  add column if not exists id uuid,
  add column if not exists project_id uuid,
  add column if not exists work_item_id uuid,
  add column if not exists kind text,
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists title text,
  add column if not exists why text,
  add column if not exists asked_of text not null default 'anyone',
  add column if not exists status text not null default 'open',
  add column if not exists score integer not null default 0,
  add column if not exists score_explain jsonb not null default '{}',
  add column if not exists actions jsonb not null default '[]',
  add column if not exists snoozed_until timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by jsonb,
  add column if not exists resolution text;

create unique index if not exists attention_unique_open on attention_items (source_type, source_id) where status = 'open';
create index if not exists attention_queue on attention_items (project_id, status, score desc, created_at)
  where status = 'open';
create index if not exists attention_work_item on attention_items (work_item_id, status);

create table if not exists attention_reconciliations (
  id uuid primary key,
  ran_at timestamptz not null default now(),
  created integer not null,
  resolved integer not null,
  drift integer not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table attention_reconciliations
  add column if not exists id uuid,
  add column if not exists ran_at timestamptz not null default now(),
  add column if not exists created integer,
  add column if not exists resolved integer,
  add column if not exists drift integer,
  add column if not exists detail jsonb not null default '{}',
  add column if not exists created_at timestamptz not null default now();

create table if not exists notification_channels (
  id uuid primary key,
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('http_webhook')),
  secret_key text not null,
  min_kind_severity text not null default 'all',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table notification_channels
  add column if not exists id uuid,
  add column if not exists project_id uuid,
  add column if not exists kind text,
  add column if not exists secret_key text,
  add column if not exists min_kind_severity text not null default 'all',
  add column if not exists enabled boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists notification_channels_project on notification_channels (project_id);

create table if not exists notification_deliveries (
  id uuid primary key,
  channel_id uuid not null references notification_channels(id),
  attention_item_id uuid references attention_items(id),
  status text not null,
  attempts integer not null default 0,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

alter table notification_deliveries
  add column if not exists id uuid,
  add column if not exists channel_id uuid,
  add column if not exists attention_item_id uuid,
  add column if not exists status text,
  add column if not exists attempts integer not null default 0,
  add column if not exists last_error text,
  add column if not exists delivered_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

create index if not exists notification_deliveries_channel on notification_deliveries (channel_id, created_at desc);

-- RLS (defence in depth; revoke anon/authenticated like prior phases).
alter table attention_items enable row level security;
alter table attention_reconciliations enable row level security;
alter table notification_channels enable row level security;
alter table notification_deliveries enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table attention_items from anon;
    revoke all on table attention_reconciliations from anon;
    revoke all on table notification_channels from anon;
    revoke all on table notification_deliveries from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table attention_items from authenticated;
    revoke all on table attention_reconciliations from authenticated;
    revoke all on table notification_channels from authenticated;
    revoke all on table notification_deliveries from authenticated;
  end if;
end $$;
