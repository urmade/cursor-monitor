-- Phase 9 review fixes: widen backtest numerics; view security_invoker; human-touches include zeros.

alter table estimate_backtests
  alter column p50_bias type numeric(14,3),
  alter column mape type numeric(14,3);

-- Recreate views with security_invoker so RLS on base tables still applies.
create or replace view v_item_costs
with (security_invoker = true) as
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

create or replace view v_rework
with (security_invoker = true) as
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

create or replace view v_gate_outcomes
with (security_invoker = true) as
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

-- Include zero-touch items (left join), the thesis metric.
create or replace view v_human_touches
with (security_invoker = true) as
select
  wi.id as work_item_id,
  wi.project_id,
  coalesce(count(i.id), 0)::integer as touch_count,
  min(i.created_at) as first_touch_at,
  max(i.created_at) as last_touch_at
from work_items wi
left join interventions i on i.work_item_id = wi.id
where wi.archived_at is null
group by wi.id, wi.project_id;

create or replace view v_stage_durations
with (security_invoker = true) as
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
