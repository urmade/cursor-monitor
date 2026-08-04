-- Store request timing captured by the paired beforeSubmitPrompt/stop hooks.

alter table cursor_stop_hook_events
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists duration_ms integer;
