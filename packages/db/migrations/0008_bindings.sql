-- Phase 2: prompt templates and automation bindings.

create table prompt_templates (
  id uuid primary key,
  project_id uuid not null references projects(id),
  name text not null,
  version integer not null,
  body text not null,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  unique (project_id, name, version)
);

create index prompt_templates_project_name_idx
  on prompt_templates (project_id, name, version desc);

create table automation_bindings (
  id uuid primary key,
  project_id uuid not null references projects(id),
  stage_id uuid not null references stages(id),
  name text not null,
  adapter text not null check (adapter in ('cloud_agent','automation_webhook')),
  condition jsonb,
  priority integer not null default 0,
  config jsonb not null,
  prompt_template_id uuid references prompt_templates(id),
  enabled boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bindings_lookup
  on automation_bindings (project_id, stage_id, enabled, priority desc)
  where archived_at is null;
