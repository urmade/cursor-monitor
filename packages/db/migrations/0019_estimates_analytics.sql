-- Phase 9: cost estimates, backtests, and thin analytics.

alter table work_items
  add column if not exists estimate_at_creation jsonb,
  add column if not exists estimate_tier integer;

create table estimate_cache (
  key text primary key,
  estimate jsonb not null,
  computed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table estimate_backtests (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  project_id uuid references projects(id),
  ran_at timestamptz not null default now(),
  sample_size integer not null,
  coverage numeric(4,3) not null,
  p50_bias numeric(6,3) not null,
  mape numeric(6,3) not null,
  by_complexity jsonb not null,
  by_tier jsonb not null,
  detail jsonb not null,
  interpretation text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index estimate_backtests_org_ran on estimate_backtests (org_id, ran_at desc);
create index estimate_backtests_project_ran on estimate_backtests (project_id, ran_at desc);

create table analytics_daily (
  day date not null,
  project_id uuid not null references projects(id),
  metrics jsonb not null,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (day, project_id)
);

create index analytics_daily_project_day on analytics_daily (project_id, day desc);

-- Shared metric definitions (read-only views).
create or replace view v_item_costs as
select
  wi.id as work_item_id,
  wi.project_id,
  wi.key,
  wi.complexity,
  wi.spend_micro_usd,
  wi.spend_source,
  wi.budget_micro_usd,
  wi.rework_cost_micro_usd,
  wi.loop_count,
  wi.estimate_at_creation,
  wi.estimate_tier,
  s.is_terminal,
  wi.archived_at,
  wi.created_at,
  wi.updated_at
from work_items wi
join stages s on s.id = wi.current_stage_id;

create or replace view v_rework as
select
  wi.id as work_item_id,
  wi.project_id,
  wi.loop_count,
  wi.rework_cost_micro_usd,
  wi.rework_ms,
  wi.spend_micro_usd,
  case
    when wi.spend_micro_usd > 0
      then wi.rework_cost_micro_usd::numeric / wi.spend_micro_usd::numeric
    else 0
  end as rework_cost_share,
  wi.loop_escalated
from work_items wi
where wi.archived_at is null;

create or replace view v_gate_outcomes as
select
  ge.id as evaluation_id,
  wi.project_id,
  ge.work_item_id,
  ge.gate_id,
  g.name as gate_name,
  ge.outcome,
  ge.created_at
from gate_evaluations ge
join work_items wi on wi.id = ge.work_item_id
join gates g on g.id = ge.gate_id;

create or replace view v_human_touches as
select
  i.work_item_id,
  wi.project_id,
  count(*)::integer as touch_count,
  min(i.created_at) as first_touch_at,
  max(i.created_at) as last_touch_at
from interventions i
join work_items wi on wi.id = i.work_item_id
group by i.work_item_id, wi.project_id;

create or replace view v_stage_durations as
select
  si.id as stage_instance_id,
  si.work_item_id,
  wi.project_id,
  si.stage_id,
  s.key as stage_key,
  s.name as stage_name,
  si.entered_at,
  si.exited_at,
  case
    when si.exited_at is not null
      then (extract(epoch from (si.exited_at - si.entered_at)) * 1000)::bigint
    else null
  end as duration_ms
from stage_instances si
join work_items wi on wi.id = si.work_item_id
join stages s on s.id = si.stage_id;

insert into feature_flags (key, enabled)
values ('p9.estimates', true)
on conflict (key) do nothing;

alter table estimate_cache enable row level security;
alter table estimate_backtests enable row level security;
alter table analytics_daily enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table estimate_cache from anon;
    revoke all on table estimate_backtests from anon;
    revoke all on table analytics_daily from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table estimate_cache from authenticated;
    revoke all on table estimate_backtests from authenticated;
    revoke all on table analytics_daily from authenticated;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke all on tables from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
  end if;
end $$;
