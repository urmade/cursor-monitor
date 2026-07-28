-- work_items.spend_source: NULL until first cost rollup (not a fake 'estimated').
-- Numbered 0015 on the Phase 5 stack (Phase 5 claimed 0014_loops). Idempotent:
-- safe to re-apply after a rename from 0014_work_item_spend_source_null.

do $$
begin
  -- Drop DEFAULT only when one is still present.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'work_items'
      and column_name = 'spend_source'
      and column_default is not null
  ) then
    execute 'alter table work_items alter column spend_source drop default';
  end if;

  -- Drop NOT NULL only while the column is still non-nullable.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'work_items'
      and column_name = 'spend_source'
      and is_nullable = 'NO'
  ) then
    execute 'alter table work_items alter column spend_source drop not null';
  end if;
end $$;

update work_items
set spend_source = null
where spend_source = 'estimated'
  and spend_micro_usd = 0
  and spend_source is not null;
