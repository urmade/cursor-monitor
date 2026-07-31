-- Cursor stop-hook telemetry: store agent-turn metadata posted from project hooks.

create table if not exists cursor_stop_hook_events (
  id uuid primary key,
  conversation_id text,
  generation_id text,
  model text,
  model_id text,
  hook_event_name text,
  cursor_version text,
  user_email text,
  transcript_path text,
  status text,
  loop_count integer,
  workspace_roots jsonb not null default '[]'::jsonb,
  model_params jsonb,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists cursor_stop_hook_events_received
  on cursor_stop_hook_events (received_at desc);

create index if not exists cursor_stop_hook_events_conversation
  on cursor_stop_hook_events (conversation_id, received_at desc)
  where conversation_id is not null;

do $$
begin
  alter table cursor_stop_hook_events enable row level security;
exception
  when undefined_table then null;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table cursor_stop_hook_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table cursor_stop_hook_events from authenticated;
  end if;
end $$;
