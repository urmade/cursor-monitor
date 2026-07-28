-- Phase 5: loops and rework — return edges, reason taxonomy, counters, budgets.

alter table stage_instances
  add column if not exists visit_index integer not null default 1;

-- Generated rework flag (visit after the first to the same stage).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stage_instances'
      and column_name = 'is_rework'
  ) then
    alter table stage_instances
      add column is_rework boolean generated always as (visit_index > 1) stored;
  end if;
end $$;

alter table transitions
  add column if not exists is_return_edge boolean not null default false,
  add column if not exists loop_edge_id uuid;

alter table work_items
  add column if not exists loop_count integer not null default 0,
  add column if not exists rework_cost_micro_usd bigint not null default 0,
  add column if not exists rework_ms bigint not null default 0,
  add column if not exists loop_escalated boolean not null default false;

create table if not exists loop_reason_codes (
  id uuid primary key,
  project_id uuid not null references projects(id),
  code text not null,
  label text not null,
  requires_note boolean not null default false,
  position integer not null default 0,
  archived_at timestamptz,
  unique (project_id, code)
);

create index if not exists loop_reason_codes_project_idx
  on loop_reason_codes (project_id, position);

create table if not exists loop_edges (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  transition_id uuid not null references transitions(id) unique,
  from_stage_id uuid not null references stages(id),
  to_stage_id uuid not null references stages(id),
  reason_code text not null,
  note text,
  trigger jsonb not null,
  occurred_at timestamptz not null default now(),
  closed_at timestamptz,
  cost_micro_usd bigint,
  duration_ms bigint,
  cost_complete boolean not null default false
);

create index if not exists loop_edges_item on loop_edges (work_item_id, occurred_at);
create index if not exists loop_edges_pair on loop_edges (from_stage_id, to_stage_id);
create index if not exists loop_edges_open
  on loop_edges (work_item_id, to_stage_id)
  where cost_complete = false;

-- Allow loop_budget evaluator on gates (expand check constraint).
alter table gates drop constraint if exists gates_evaluator_check;
alter table gates
  add constraint gates_evaluator_check
  check (evaluator in (
    'field_rule','human_approval','budget','agentic','loop_budget'
  ));

-- Backfill visit_index from seq order per (work_item, stage).
-- Idempotent: recomputes from current rows every run.
with ranked as (
  select
    id,
    row_number() over (
      partition by work_item_id, stage_id
      order by seq asc, entered_at asc, id asc
    ) as vi
  from stage_instances
)
update stage_instances si
set visit_index = ranked.vi
from ranked
where si.id = ranked.id
  and si.visit_index is distinct from ranked.vi;

-- Mark historical backward transitions that revisit a stage as return edges,
-- and create loop_edges with reason_code = 'unknown' when missing.
-- Only count as a loop when a prior stage_instance of the target stage exists
-- with lower seq than the instance entered by this transition.
with candidates as (
  select
    t.id as transition_id,
    t.work_item_id,
    t.from_stage_id,
    t.to_stage_id,
    t.created_at,
    (
      select si.seq
      from stage_instances si
      where si.work_item_id = t.work_item_id
        and si.stage_id = t.to_stage_id
        and si.entered_at <= t.created_at + interval '1 second'
      order by si.seq desc
      limit 1
    ) as entered_seq
  from transitions t
  where t.direction = 'backward'
    and t.from_stage_id is not null
    and t.is_return_edge = false
),
confirmed as (
  select c.*
  from candidates c
  where c.entered_seq is not null
    and exists (
      select 1
      from stage_instances prior
      where prior.work_item_id = c.work_item_id
        and prior.stage_id = c.to_stage_id
        and prior.seq < c.entered_seq
    )
)
update transitions t
set is_return_edge = true
from confirmed c
where t.id = c.transition_id;

insert into loop_edges (
  id, work_item_id, transition_id, from_stage_id, to_stage_id,
  reason_code, note, trigger, occurred_at, cost_complete
)
select
  md5(t.id::text || ':loop_edge')::uuid,
  t.work_item_id,
  t.id,
  t.from_stage_id,
  t.to_stage_id,
  coalesce(nullif(t.reason_code, ''), 'unknown'),
  t.note,
  jsonb_build_object('kind', 'backfill', 'by', 'migration_0013'),
  t.created_at,
  false
from transitions t
where t.is_return_edge = true
  and t.from_stage_id is not null
  and not exists (
    select 1 from loop_edges le where le.transition_id = t.id
  );

update transitions t
set loop_edge_id = le.id
from loop_edges le
where le.transition_id = t.id
  and t.loop_edge_id is distinct from le.id;

-- Denormalised loop_count from loop_edges.
update work_items w
set loop_count = coalesce((
  select count(*)::int from loop_edges le where le.work_item_id = w.id
), 0);

-- Rework cost = sum of stage_instance costs where visit_index > 1.
update work_items w
set rework_cost_micro_usd = coalesce((
  select sum(si.cost_micro_usd)::bigint
  from stage_instances si
  where si.work_item_id = w.id and si.visit_index > 1
), 0);

update work_items w
set rework_ms = coalesce((
  select sum(
    greatest(
      0,
      (extract(epoch from (coalesce(si.exited_at, now()) - si.entered_at)) * 1000)::bigint
    )
  )::bigint
  from stage_instances si
  where si.work_item_id = w.id and si.visit_index > 1
), 0);

-- Rework metrics views for Phase 9.
create or replace view rework_rate_by_project as
select
  p.id as project_id,
  p.key as project_key,
  count(w.id)::int as item_count,
  count(w.id) filter (where w.loop_count > 0)::int as looped_item_count,
  case
    when count(w.id) = 0 then 0::numeric
    else round(
      (count(w.id) filter (where w.loop_count > 0))::numeric / count(w.id)::numeric,
      4
    )
  end as rework_rate,
  coalesce(avg(w.loop_count) filter (where w.loop_count > 0), 0)::numeric as mean_loops_when_looped,
  coalesce(avg(w.rework_cost_micro_usd) filter (where w.loop_count > 0), 0)::numeric as mean_rework_cost_micro_usd
from projects p
left join work_items w on w.project_id = p.id and w.archived_at is null
group by p.id, p.key;

create or replace view rework_loops_distribution as
select
  w.project_id,
  w.loop_count,
  count(*)::int as item_count
from work_items w
where w.archived_at is null
group by w.project_id, w.loop_count;

create or replace view rework_top_stage_pairs as
select
  wi.project_id,
  le.from_stage_id,
  le.to_stage_id,
  count(*)::int as return_count,
  coalesce(sum(le.cost_micro_usd), 0)::bigint as total_cost_micro_usd,
  coalesce(avg(le.cost_micro_usd) filter (where le.cost_complete), 0)::numeric as mean_cost_micro_usd
from loop_edges le
join work_items wi on wi.id = le.work_item_id
group by wi.project_id, le.from_stage_id, le.to_stage_id;

insert into feature_flags (key, enabled) values
  ('p5.loops', true)
on conflict (key) do nothing;

do $$
declare
  t text;
begin
  foreach t in array array['loop_reason_codes', 'loop_edges']
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
