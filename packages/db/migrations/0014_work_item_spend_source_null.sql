-- work_items.spend_source: NULL until first cost rollup (not a fake 'estimated').

alter table work_items alter column spend_source drop default;
alter table work_items alter column spend_source drop not null;

update work_items
set spend_source = null
where spend_source = 'estimated' and spend_micro_usd = 0;
