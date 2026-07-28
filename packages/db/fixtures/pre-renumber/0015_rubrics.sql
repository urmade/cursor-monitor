-- Phase 7: rubrics, verdicts, golden set, remediation columns, internal_llm adapter.

-- Expand runs.adapter check to include internal_llm (evaluation cost rows).
alter table runs drop constraint if exists runs_adapter_check;
alter table runs
  add constraint runs_adapter_check
  check (adapter in ('cloud_agent', 'automation_webhook', 'internal_llm'));

alter table gates
  add column if not exists remediation_binding_id uuid references automation_bindings(id);
alter table gates
  add column if not exists remediation_max_attempts integer not null default 2;

alter table work_items
  add column if not exists remediation_attempts integer not null default 0;

create table rubrics (
  id uuid primary key,
  project_id uuid not null references projects(id),
  name text not null,
  version integer not null,
  target text not null check (target in ('spec', 'stage_report')),
  question text not null,
  criteria jsonb not null,
  pass_when text not null,
  block_when text not null,
  guidance text not null default '',
  model text not null,
  max_output_tokens integer not null default 1200,
  uncertainty_policy text not null default 'warn'
    check (uncertainty_policy in ('warn', 'pass', 'block')),
  enabled boolean not null default false,
  created_by_user_id uuid references users(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name, version)
);

create index rubrics_project_idx on rubrics (project_id) where archived_at is null;

create table rubric_verdicts (
  id uuid primary key,
  rubric_id uuid not null references rubrics(id),
  rubric_version integer not null,
  work_item_id uuid not null references work_items(id),
  gate_evaluation_id uuid references gate_evaluations(id),
  target_kind text not null check (target_kind in ('spec', 'stage_report')),
  target_ref uuid not null,
  content_hash text not null,
  outcome text not null check (outcome in ('pass', 'warn', 'block', 'error')),
  confidence numeric(3, 2),
  headline text not null,
  criteria jsonb not null,
  suggested_remediation text,
  model text not null,
  tokens jsonb,
  cost_micro_usd bigint,
  duration_ms integer,
  cache_hit boolean not null default false,
  raw_response jsonb,
  run_id uuid,
  error_code text,
  created_at timestamptz not null default now()
);

create index rubric_verdicts_cache on rubric_verdicts (rubric_id, rubric_version, content_hash);
create index rubric_verdicts_item on rubric_verdicts (work_item_id, created_at desc);
create index rubric_verdicts_gate_eval on rubric_verdicts (gate_evaluation_id);

create table rubric_golden_cases (
  id uuid primary key,
  rubric_id uuid not null references rubrics(id),
  label text not null,
  content jsonb not null,
  expected_outcome text not null check (expected_outcome in ('pass', 'warn', 'block')),
  note text,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create index rubric_golden_cases_rubric on rubric_golden_cases (rubric_id, created_at desc);

create table rubric_regression_runs (
  id uuid primary key,
  rubric_id uuid not null references rubrics(id),
  rubric_version integer not null,
  total integer not null,
  matched integer not null,
  results jsonb not null,
  cost_micro_usd bigint,
  created_at timestamptz not null default now()
);

create index rubric_regression_runs_rubric
  on rubric_regression_runs (rubric_id, rubric_version, created_at desc);

create table pending_evaluations (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  gate_id uuid not null references gates(id),
  project_id uuid not null references projects(id),
  trigger jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  job_id uuid,
  verdict_id uuid,
  error_detail text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index pending_evaluations_open
  on pending_evaluations (work_item_id, gate_id)
  where status in ('pending', 'running');
create index pending_evaluations_item on pending_evaluations (work_item_id, status);

-- RLS defence in depth
alter table rubrics enable row level security;
alter table rubric_verdicts enable row level security;
alter table rubric_golden_cases enable row level security;
alter table rubric_regression_runs enable row level security;
alter table pending_evaluations enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table rubrics from anon;
    revoke all on table rubric_verdicts from anon;
    revoke all on table rubric_golden_cases from anon;
    revoke all on table rubric_regression_runs from anon;
    revoke all on table pending_evaluations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table rubrics from authenticated;
    revoke all on table rubric_verdicts from authenticated;
    revoke all on table rubric_golden_cases from authenticated;
    revoke all on table rubric_regression_runs from authenticated;
    revoke all on table pending_evaluations from authenticated;
  end if;
end $$;

-- Prevent Supabase default privileges from re-granting on future CREATE TABLE.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke all on tables from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
  end if;
end $$;
