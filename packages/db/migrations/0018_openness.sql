-- Phase 8: public API tokens, outbound webhooks, idempotency, event public_type.

alter table events add column if not exists public_type text;

create index if not exists events_publishable on events (occurred_at, id)
  where public_type is not null;

create table api_tokens (
  id uuid primary key,
  project_id uuid not null references projects(id),
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null,
  created_by_user_id uuid references users(id),
  last_used_at timestamptz,
  use_count bigint not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index api_tokens_project on api_tokens (project_id, created_at desc);
create index api_tokens_prefix on api_tokens (token_prefix);

create table webhook_endpoints (
  id uuid primary key,
  project_id uuid not null references projects(id),
  url text not null,
  secret_hash text not null,
  secret_encrypted text not null,
  event_types text[] not null,
  enabled boolean not null default true,
  description text,
  consecutive_failures integer not null default 0,
  disabled_at timestamptz,
  disabled_reason text,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index webhook_endpoints_project on webhook_endpoints (project_id, created_at desc);

create table webhook_deliveries (
  id uuid primary key,
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_id uuid not null references events(id),
  event_type text not null,
  status text not null check (status in ('pending','delivered','failed','dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  request_body_bytes integer,
  request_truncated boolean not null default false,
  response_status integer,
  response_body_excerpt text,
  response_ms integer,
  error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index deliveries_pending on webhook_deliveries (status, next_attempt_at)
  where status = 'pending';
create index deliveries_endpoint on webhook_deliveries (endpoint_id, created_at desc);

create table api_request_log (
  id uuid primary key,
  token_id uuid references api_tokens(id),
  method text not null,
  path text not null,
  status integer not null,
  duration_ms integer,
  request_id text,
  idempotency_key text,
  idempotency_hit boolean not null default false,
  created_at timestamptz not null default now()
);

create index api_request_log_token on api_request_log (token_id, created_at desc);

create table idempotency_keys (
  key text not null,
  token_id uuid not null references api_tokens(id) on delete cascade,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (key, token_id)
);

-- Backfill public_type for catalogued internal event types.
update events set public_type = type
where public_type is null
  and type in (
    'work_item.created','work_item.updated','work_item.stage_changed',
    'spec.version_created','run.started','run.finished','stage_report.posted',
    'question.asked','question.answered','gate.evaluated',
    'budget.threshold_crossed','budget.blocked','loop.detected','loop.escalated'
  );

update events set public_type = 'approval.decided'
where public_type is null and type in ('approval.approved','approval.rejected');

alter table api_tokens enable row level security;
alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;
alter table api_request_log enable row level security;
alter table idempotency_keys enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table api_tokens from anon;
    revoke all on table webhook_endpoints from anon;
    revoke all on table webhook_deliveries from anon;
    revoke all on table api_request_log from anon;
    revoke all on table idempotency_keys from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table api_tokens from authenticated;
    revoke all on table webhook_endpoints from authenticated;
    revoke all on table webhook_deliveries from authenticated;
    revoke all on table api_request_log from authenticated;
    revoke all on table idempotency_keys from authenticated;
  end if;
end $$;
