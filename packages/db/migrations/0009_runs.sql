-- Phase 2: runs, MCP tokens, stage reports, questions, artifact refs, call log.

create table runs (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  stage_instance_id uuid not null references stage_instances(id),
  binding_id uuid references automation_bindings(id),
  prompt_template_id uuid references prompt_templates(id),
  adapter text not null check (adapter in ('cloud_agent','automation_webhook')),
  trigger jsonb not null,
  status text not null,
  nonce text not null unique,
  attempt integer not null default 1,
  provider_agent_id text,
  provider_run_id text,
  provider_url text,
  model text,
  launched_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  deadline_at timestamptz not null,
  duration_ms integer,
  tokens jsonb,
  usage_uuid text,
  git_snapshot jsonb,
  outcome text,
  error_code text,
  error_detail text,
  last_polled_at timestamptz,
  poll_attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create index runs_active on runs (status, deadline_at)
  where status in ('pending','launched','running');
create unique index runs_one_active_per_item on runs (work_item_id)
  where status in ('pending','launched','running');
create index runs_work_item_created on runs (work_item_id, created_at desc);
create index runs_provider_agent on runs (provider_agent_id)
  where provider_agent_id is not null;

create table mcp_tokens (
  id uuid primary key,
  token_hash text not null unique,
  token_prefix text not null,
  run_id uuid references runs(id),
  work_item_id uuid not null references work_items(id),
  project_id uuid not null references projects(id),
  scopes text[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index mcp_tokens_run_idx on mcp_tokens (run_id);
create index mcp_tokens_work_item_idx on mcp_tokens (work_item_id);

create table stage_reports (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  stage_instance_id uuid not null references stage_instances(id),
  run_id uuid not null references runs(id) unique,
  outcome text not null,
  confidence numeric(3,2),
  headline text not null,
  summary text not null default '',
  assumptions jsonb not null default '[]',
  not_verified jsonb not null default '[]',
  raw jsonb not null,
  created_at timestamptz not null default now()
);

create index stage_reports_work_item_idx on stage_reports (work_item_id, created_at desc);

create table questions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  run_id uuid references runs(id),
  stage_instance_id uuid references stage_instances(id),
  text text not null,
  options jsonb not null default '[]',
  blocking boolean not null default false,
  status text not null default 'open'
    check (status in ('open','answered','withdrawn','superseded')),
  answer text,
  answered_by_user_id uuid references users(id),
  answered_at timestamptz,
  resume_run_id uuid references runs(id),
  created_at timestamptz not null default now()
);

create index questions_open on questions (work_item_id) where status = 'open';
create index questions_project_open on questions (work_item_id, created_at desc);

create table artifact_refs (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  run_id uuid references runs(id),
  kind text not null,
  url text not null,
  title text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index artifact_refs_work_item_idx on artifact_refs (work_item_id, created_at desc);
create index artifact_refs_run_idx on artifact_refs (run_id);

create table mcp_call_log (
  id uuid primary key,
  token_id uuid references mcp_tokens(id),
  run_id uuid references runs(id),
  work_item_id uuid references work_items(id),
  tool text not null,
  ok boolean not null,
  error_code text,
  duration_ms integer,
  request_bytes integer,
  response_bytes integer,
  created_at timestamptz not null default now()
);

create index mcp_call_log_run_idx on mcp_call_log (run_id, created_at desc);
create index mcp_call_log_created_idx on mcp_call_log (created_at);

alter table work_items
  add column current_run_id uuid references runs(id),
  add column last_report_id uuid references stage_reports(id);

insert into feature_flags (key, enabled) values
  ('p2.mcp', true),
  ('p2.bindings', true),
  ('p2.runs', true),
  ('orchestration.enabled', true)
on conflict (key) do nothing;

-- Defence in depth: RLS on new tables (same posture as 0007).
do $$
declare
  t text;
begin
  foreach t in array array[
    'prompt_templates','automation_bindings','runs','mcp_tokens',
    'stage_reports','questions','artifact_refs','mcp_call_log'
  ]
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
