-- Phase 1: projects, members, stages, labels.

create table projects (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  key text not null,
  name text not null,
  description text not null default '',
  owner_user_id uuid references users(id),
  next_item_number integer not null default 1,
  optional_concepts jsonb not null default '{"acceptanceCriteria":false,"visualConfirmation":false}',
  settings jsonb not null default '{}',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create index projects_org_id_idx on projects (org_id);

create table project_members (
  project_id uuid not null references projects(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('owner','maintainer','member','viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_id_idx on project_members (user_id);

create table stages (
  id uuid primary key,
  project_id uuid not null references projects(id),
  key text not null,
  name text not null,
  position integer not null,
  default_owner_class text not null check (default_owner_class in ('ai','human','external')),
  is_initial boolean not null default false,
  is_terminal boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);

create unique index stages_one_initial on stages (project_id)
  where is_initial and archived_at is null;

create index stages_project_position_idx on stages (project_id, position);

create table labels (
  id uuid primary key,
  project_id uuid not null references projects(id),
  key text not null,
  name text not null,
  color text not null default 'gray',
  category text,
  agent_settable boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);

create index labels_project_id_idx on labels (project_id);
