-- Phase 5: loops and rework — return edges, reason taxonomy, counters, budgets.
-- Numbered 0014 (Phase 4 claimed 0013_model_prices_created_at).

alter table stage_instances
  add column if not exists visit_index integer not null default 1;

-- Preview may still have the early generated form of is_rework
-- (`generated always as (visit_index > 1) stored`) from 0013_loops before
-- the renumber. `ADD COLUMN IF NOT EXISTS` would skip and leave it
-- generated, then the UPDATE below fails with 428C9. Drop first so the
-- plain column can be created; values are re-derived from visit_index.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stage_instances'
      and column_name = 'is_rework'
      and is_generated = 'ALWAYS'
  ) then
    alter table stage_instances drop column is_rework;
  end if;
end $$;

-- Plain boolean maintained by the app (avoid generated STORED rewrite lock).
alter table stage_instances
  add column if not exists is_rework boolean not null default false;

update stage_instances
set is_rework = (visit_index > 1)
where is_rework is distinct from (visit_index > 1);

alter table transitions
  add column if not exists is_return_edge boolean not null default false,
  add column if not exists loop_edge_id uuid;

alter table work_items
  add column if not exists loop_count integer not null default 0,
  add column if not exists rework_cost_micro_usd bigint not null default 0,
  add column if not exists rework_ms bigint not null default 0,
  add column if not exists loop_escalated boolean not null default false;

-- CREATE TABLE IF NOT EXISTS is a no-op when preview already applied the
-- original 0013_loops shape. Follow every create with ADD COLUMN IF NOT EXISTS
-- so rework-added columns land on the older table.
create table if not exists loop_reason_codes (
  id uuid primary key,
  project_id uuid not null references projects(id),
  code text not null,
  label text not null,
  requires_note boolean not null default false,
  position integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, code)
);

alter table loop_reason_codes
  add column if not exists id uuid,
  add column if not exists project_id uuid,
  add column if not exists code text,
  add column if not exists label text,
  add column if not exists requires_note boolean not null default false,
  add column if not exists position integer not null default 0,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

create index if not exists loop_reason_codes_project_idx
  on loop_reason_codes (project_id, position);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'loop_reason_codes_project_id_code_key'
  ) then
    alter table loop_reason_codes
      add constraint loop_reason_codes_project_id_code_key unique (project_id, code);
  end if;
exception
  when duplicate_object then null;
  when unique_violation then null;
end $$;

create table if not exists loop_edges (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  transition_id uuid not null references transitions(id) unique,
  from_stage_id uuid not null references stages(id),
  to_stage_id uuid not null references stages(id),
  -- Stage instance entered by this return; cost is finalised from this row.
  to_stage_instance_id uuid references stage_instances(id),
  reason_code text not null,
  note text,
  trigger jsonb not null,
  occurred_at timestamptz not null default now(),
  closed_at timestamptz,
  cost_micro_usd bigint,
  duration_ms bigint,
  cost_complete boolean not null default false,
  created_at timestamptz not null default now()
);

alter table loop_edges
  add column if not exists id uuid,
  add column if not exists work_item_id uuid,
  add column if not exists transition_id uuid,
  add column if not exists from_stage_id uuid,
  add column if not exists to_stage_id uuid,
  add column if not exists to_stage_instance_id uuid,
  add column if not exists reason_code text,
  add column if not exists note text,
  add column if not exists trigger jsonb,
  add column if not exists occurred_at timestamptz not null default now(),
  add column if not exists closed_at timestamptz,
  add column if not exists cost_micro_usd bigint,
  add column if not exists duration_ms bigint,
  add column if not exists cost_complete boolean not null default false,
  add column if not exists created_at timestamptz not null default now();

-- FK for the rework-added column (CREATE TABLE path already declares it).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'loop_edges_to_stage_instance_id_fkey'
  ) then
    alter table loop_edges
      add constraint loop_edges_to_stage_instance_id_fkey
      foreign key (to_stage_instance_id) references stage_instances(id);
  end if;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'loop_edges_transition_id_key'
  ) then
    alter table loop_edges
      add constraint loop_edges_transition_id_key unique (transition_id);
  end if;
exception
  when duplicate_object then null;
  when unique_violation then null;
end $$;

create index if not exists loop_edges_item on loop_edges (work_item_id, occurred_at);
create index if not exists loop_edges_pair on loop_edges (from_stage_id, to_stage_id);
create index if not exists loop_edges_open
  on loop_edges (work_item_id, to_stage_id)
  where cost_complete = false;
create index if not exists loop_edges_instance
  on loop_edges (to_stage_instance_id)
  where to_stage_instance_id is not null;

-- Original 0013_loops shipped SQL views; rework removed them. Drop so an
-- old-shape preview converges with a fresh migrate.
drop view if exists rework_rate_by_project;
drop view if exists rework_loops_distribution;
drop view if exists rework_top_stage_pairs;

alter table gates drop constraint if exists gates_evaluator_check;
alter table gates
  add constraint gates_evaluator_check
  check (evaluator in (
    'field_rule','human_approval','budget','agentic','loop_budget'
  ));

-- Backfill visit_index (idempotent absolute recompute).
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
set
  visit_index = ranked.vi,
  is_rework = (ranked.vi > 1)
from ranked
where si.id = ranked.id
  and (
    si.visit_index is distinct from ranked.vi
    or si.is_rework is distinct from (ranked.vi > 1)
  );

with candidates as (
  select
    t.id as transition_id,
    t.work_item_id,
    t.from_stage_id,
    t.to_stage_id,
    t.created_at,
    (
      select si.id
      from stage_instances si
      where si.work_item_id = t.work_item_id
        and si.stage_id = t.to_stage_id
        and si.entered_at <= t.created_at + interval '1 second'
      order by si.seq desc
      limit 1
    ) as entered_instance_id,
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

-- Deterministic ids so re-running the insert is a no-op (idempotent).
insert into loop_edges (
  id, work_item_id, transition_id, from_stage_id, to_stage_id,
  to_stage_instance_id, reason_code, note, trigger, occurred_at, cost_complete
)
select
  md5(t.id::text || ':loop_edge')::uuid,
  t.work_item_id,
  t.id,
  t.from_stage_id,
  t.to_stage_id,
  (
    select si.id
    from stage_instances si
    where si.work_item_id = t.work_item_id
      and si.stage_id = t.to_stage_id
      and si.entered_at <= t.created_at + interval '1 second'
    order by si.seq desc
    limit 1
  ),
  coalesce(nullif(t.reason_code, ''), 'unknown'),
  t.note,
  jsonb_build_object('kind', 'backfill', 'by', 'migration_0014'),
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

-- Absolute counter recomputes (only rows that need change — avoid dead tuples).
update work_items w
set loop_count = sub.c
from (
  select wi.id, coalesce(count(le.id), 0)::int as c
  from work_items wi
  left join loop_edges le on le.work_item_id = wi.id
  group by wi.id
) sub
where w.id = sub.id
  and w.loop_count is distinct from sub.c;

update work_items w
set rework_cost_micro_usd = sub.c
from (
  select wi.id, coalesce(sum(si.cost_micro_usd), 0)::bigint as c
  from work_items wi
  left join stage_instances si
    on si.work_item_id = wi.id and si.visit_index > 1
  group by wi.id
) sub
where w.id = sub.id
  and w.rework_cost_micro_usd is distinct from sub.c;

-- rework_ms: CLOSED rework visits only (exited_at is not null) — never open ones.
update work_items w
set rework_ms = sub.c
from (
  select wi.id, coalesce(sum(
    greatest(
      0,
      (extract(epoch from (si.exited_at - si.entered_at)) * 1000)::bigint
    )
  ), 0)::bigint as c
  from work_items wi
  left join stage_instances si
    on si.work_item_id = wi.id
    and si.visit_index > 1
    and si.exited_at is not null
  group by wi.id
) sub
where w.id = sub.id
  and w.rework_ms is distinct from sub.c;

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
    execute 'alter default privileges in schema public revoke all on tables from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
  end if;
end $$;
