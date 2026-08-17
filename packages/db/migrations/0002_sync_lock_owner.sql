delete from monitor_sync_locks;

alter table monitor_sync_locks
  add column if not exists owner_id uuid;

alter table monitor_sync_locks
  alter column owner_id set not null;
