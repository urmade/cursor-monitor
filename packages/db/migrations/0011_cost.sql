-- Phase 4: economics — prices, run costs, rollups, budgets, audit.

create table model_prices (
  id uuid primary key,
  model text not null,
  input_micro_usd_per_1k bigint not null,
  output_micro_usd_per_1k bigint not null,
  cache_write_micro_usd_per_1k bigint not null default 0,
  cache_read_micro_usd_per_1k bigint not null default 0,
  surcharge_bps integer not null default 0,
  effective_from timestamptz not null,
  note text,
  unique (model, effective_from)
);

create index model_prices_model_effective on model_prices (model, effective_from desc);

alter table runs
  add column cost_estimate_micro_usd bigint,
  add column cost_actual_micro_usd bigint,
  add column cost_micro_usd bigint,
  add column cost_source text check (cost_source in ('estimated','provider','admin_reconciled','mixed')),
  add column price_row_id uuid references model_prices(id),
  add column reconciled_at timestamptz,
  add column allocation_method text;

alter table stage_instances
  add column cost_micro_usd bigint not null default 0;

alter table work_items
  add column budget_micro_usd bigint,
  add column budget_overridden boolean not null default false,
  add column spend_micro_usd bigint not null default 0,
  add column spend_source text not null default 'estimated',
  add column paused_reason text;

alter table projects
  add column spend_micro_usd bigint not null default 0;

create table budget_events (
  id uuid primary key,
  project_id uuid not null references projects(id),
  work_item_id uuid references work_items(id),
  kind text not null,
  scope text not null check (scope in ('item','project')),
  before jsonb not null,
  after jsonb not null,
  actor jsonb not null,
  reason text,
  created_at timestamptz not null default now()
);

create index budget_events_project on budget_events (project_id, created_at desc);

create table cost_rollup_checks (
  id uuid primary key,
  scope text not null,
  subject_id uuid not null,
  stored_micro_usd bigint not null,
  recomputed_micro_usd bigint not null,
  drift_micro_usd bigint not null,
  created_at timestamptz not null default now()
);

-- Seed baseline model prices (Q8 placeholders; owner-editable).
insert into model_prices (
  id, model,
  input_micro_usd_per_1k, output_micro_usd_per_1k,
  cache_write_micro_usd_per_1k, cache_read_micro_usd_per_1k,
  surcharge_bps, effective_from, note
) values
  (
    'a1000001-0000-4000-8000-000000000001',
    'claude-sonnet-4',
    3000, 15000, 3750, 300, 0,
    '2025-01-01T00:00:00Z',
    'Placeholder Sonnet-class pricing per 1k tokens (micro-USD)'
  ),
  (
    'a1000001-0000-4000-8000-000000000002',
    'gpt-4.1',
    2000, 8000, 0, 500, 500,
    '2025-01-01T00:00:00Z',
    'Placeholder GPT-4.1 with 5% Cursor surcharge_bps demo'
  ),
  (
    'a1000001-0000-4000-8000-000000000003',
    'default',
    2500, 10000, 0, 0, 0,
    '2025-01-01T00:00:00Z',
    'Fallback when model string is unknown — estimate zero path uses warning instead'
  );

insert into feature_flags (key, enabled) values
  ('p4.budgets', true)
on conflict (key) do nothing;

do $$
declare
  t text;
begin
  foreach t in array array['model_prices','budget_events','cost_rollup_checks']
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
