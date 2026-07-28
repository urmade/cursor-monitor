-- Phase 6: attention inbox projection, reconciliation, notifications.

create table attention_items (
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

create unique index attention_unique_open on attention_items (source_type, source_id) where status = 'open';
create index attention_queue on attention_items (project_id, status, score desc, created_at)
  where status = 'open';
create index attention_work_item on attention_items (work_item_id, status);

create table attention_reconciliations (
  id uuid primary key,
  ran_at timestamptz not null default now(),
  created integer not null,
  resolved integer not null,
  drift integer not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table notification_channels (
  id uuid primary key,
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('http_webhook')),
  secret_key text not null,
  min_kind_severity text not null default 'all',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_channels_project on notification_channels (project_id);

create table notification_deliveries (
  id uuid primary key,
  channel_id uuid not null references notification_channels(id),
  attention_item_id uuid references attention_items(id),
  status text not null,
  attempts integer not null default 0,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index notification_deliveries_channel on notification_deliveries (channel_id, created_at desc);

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
