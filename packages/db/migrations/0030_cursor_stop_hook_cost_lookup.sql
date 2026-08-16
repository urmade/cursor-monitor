-- Delayed Team usage-API cost lookup for stop-hook rows.
-- Incoming hooks persist immediately; a 5-minute cadence job fills charged_cents.

alter table cursor_stop_hook_events
  add column if not exists cost_looked_up_at timestamptz;

create index if not exists cursor_stop_hook_events_pending_cost
  on cursor_stop_hook_events (received_at desc)
  where charged_cents is null;
