-- Phase 1: work items, labels join, specs, status overrides.

create table work_items (
  id uuid primary key,
  project_id uuid not null references projects(id),
  number integer not null,
  key text not null,
  title text not null,
  description text not null default '',
  complexity text check (complexity in ('low','medium','high')),
  current_stage_id uuid not null references stages(id),
  current_stage_instance_id uuid,
  current_spec_version_id uuid,
  owner_class text not null default 'human' check (owner_class in ('ai','human','external')),
  externally_blocked_reason text,
  parent_work_item_id uuid references work_items(id),
  created_by_user_id uuid references users(id),
  version integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number),
  unique (project_id, key)
);

create index work_items_project_stage_idx on work_items (project_id, current_stage_id)
  where archived_at is null;
create index work_items_project_created_idx on work_items (project_id, created_at desc);

create table work_item_labels (
  work_item_id uuid not null references work_items(id) on delete cascade,
  label_id uuid not null references labels(id),
  set_by_actor jsonb not null,
  created_at timestamptz not null default now(),
  primary key (work_item_id, label_id)
);

create index work_item_labels_label_id_idx on work_item_labels (label_id);

create table spec_versions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  version integer not null,
  content jsonb not null,
  authored_by jsonb not null,
  note text,
  created_at timestamptz not null default now(),
  unique (work_item_id, version)
);

create index spec_versions_work_item_idx on spec_versions (work_item_id, version desc);

create table status_overrides (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  status text not null,
  reason text not null,
  set_by_user_id uuid not null references users(id),
  cleared_at timestamptz,
  created_at timestamptz not null default now()
);

create index status_overrides_work_item_idx on status_overrides (work_item_id)
  where cleared_at is null;
