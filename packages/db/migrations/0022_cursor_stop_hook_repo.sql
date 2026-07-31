-- Enrich stop-hook events with repo / branch for the signals dashboard.

alter table cursor_stop_hook_events
  add column if not exists workspace_root text,
  add column if not exists repo text,
  add column if not exists git_branch text;

create index if not exists cursor_stop_hook_events_user_repo
  on cursor_stop_hook_events (user_email, repo, received_at desc);

create index if not exists cursor_stop_hook_events_repo_conversation
  on cursor_stop_hook_events (repo, conversation_id, received_at desc);
