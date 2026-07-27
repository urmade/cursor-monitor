-- Phase 1: stage instances, transitions, event outbox.

create table stage_instances (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  stage_id uuid not null references stages(id),
  seq integer not null,
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  unique (work_item_id, seq)
);

create index stage_instances_work_item_idx on stage_instances (work_item_id, seq);
create index stage_instances_open_idx on stage_instances (work_item_id)
  where exited_at is null;

alter table work_items
  add constraint work_items_current_stage_instance_id_fkey
  foreign key (current_stage_instance_id) references stage_instances(id);

alter table work_items
  add constraint work_items_current_spec_version_id_fkey
  foreign key (current_spec_version_id) references spec_versions(id);

create table transitions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  from_stage_id uuid references stages(id),
  to_stage_id uuid not null references stages(id),
  direction text not null check (direction in ('forward','backward','lateral','initial')),
  reason_code text,
  note text,
  actor jsonb not null,
  gate_evaluation_id uuid,
  created_at timestamptz not null default now()
);

create index transitions_work_item_idx on transitions (work_item_id, created_at);

create table events (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  project_id uuid references projects(id),
  type text not null,
  subject_type text not null,
  subject_id uuid not null,
  actor jsonb not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create index events_project_occurred on events (project_id, occurred_at desc);
create index events_subject on events (subject_type, subject_id, occurred_at desc);
create index events_org_occurred on events (org_id, occurred_at desc);
