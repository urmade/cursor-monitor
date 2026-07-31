-- Store Cursor Admin usage-event cost on stop-hook log rows.

alter table cursor_stop_hook_events
  add column if not exists charged_cents double precision,
  add column if not exists cost_source text,
  add column if not exists cost_lookup_error text,
  add column if not exists usage_event jsonb;
