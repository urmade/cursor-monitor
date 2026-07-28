-- Phase 3: gates, evaluations, warnings, approvals, interventions.
-- Forward-only, expand/contract safe. transitions.gate_evaluation_id already exists (nullable).

create table gates (
  id uuid primary key,
  project_id uuid not null references projects(id),
  name text not null,
  description text not null default '',
  evaluator text not null check (evaluator in ('field_rule','human_approval','budget','agentic')),
  trigger jsonb not null,
  applies_when jsonb,
  config jsonb not null,
  on_failure text not null default 'block' check (on_failure in ('block','warn')),
  enabled boolean not null default false,
  version integer not null default 1,
  created_by_user_id uuid references users(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gates_lookup on gates (project_id, enabled) where archived_at is null;
create index gates_project_idx on gates (project_id) where archived_at is null;

create table gate_evaluations (
  id uuid primary key,
  gate_id uuid not null references gates(id),
  gate_version integer not null,
  gate_config jsonb not null,
  work_item_id uuid not null references work_items(id),
  stage_instance_id uuid references stage_instances(id),
  trigger jsonb not null,
  outcome text not null check (outcome in ('pass','warn','block','skipped','error')),
  reason text not null,
  evidence jsonb not null default '{}',
  context_snapshot jsonb not null,
  evaluator_meta jsonb not null default '{}',
  batch_id uuid not null,
  created_at timestamptz not null default now()
);
create index gate_evals_item on gate_evaluations (work_item_id, created_at desc);
create index gate_evals_batch on gate_evaluations (batch_id);
create index gate_evals_gate on gate_evaluations (gate_id, created_at desc);
create index gate_evals_created on gate_evaluations (created_at);

create table warnings (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  gate_id uuid references gates(id),
  gate_evaluation_id uuid references gate_evaluations(id),
  origin_stage_instance_id uuid references stage_instances(id),
  code text not null,
  message text not null,
  status text not null default 'open' check (status in ('open','dismissed','resolved')),
  resolved_by_evaluation_id uuid references gate_evaluations(id),
  dismissed_by_user_id uuid references users(id),
  dismissed_reason text,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);
create index warnings_open on warnings (work_item_id) where status = 'open';
create index warnings_item on warnings (work_item_id, created_at desc);
-- De-dupe open warnings by (work_item, gate, code)
create unique index warnings_open_dedupe on warnings (work_item_id, gate_id, code)
  where status = 'open' and gate_id is not null;

create table approvals (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  gate_id uuid not null references gates(id),
  gate_evaluation_id uuid not null references gate_evaluations(id),
  requested_at timestamptz not null default now(),
  requested_for jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  decided_by_user_id uuid references users(id),
  decided_at timestamptz,
  comment text,
  created_at timestamptz not null default now()
);
create unique index approvals_one_pending on approvals (work_item_id, gate_id) where status = 'pending';
create index approvals_project_pending on approvals (work_item_id, status);

create table interventions (
  id uuid primary key,
  work_item_id uuid references work_items(id),
  project_id uuid not null references projects(id),
  kind text not null,
  actor jsonb not null,
  target jsonb not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index interventions_item on interventions (work_item_id, created_at desc);
create index interventions_project on interventions (project_id, created_at desc);
