-- Phase 3 follow-up: RLS on gate tables (0010 omitted this; do not edit applied 0010).
-- Also: store gate name on evaluations; track gate batch on transitions; drop redundant index.
--
-- Note: there is no 0011_* in this branch. Phase 4 owns migration 0011; the id-tracked
-- runner applies files by name, so a numeric gap is harmless and intentional.

alter table gate_evaluations
  add column if not exists gate_name text not null default '';

alter table transitions
  add column if not exists gate_batch_id uuid;

-- gates_lookup already covers (project_id, enabled); drop the redundant project-only index.
drop index if exists gates_project_idx;

do $$
declare
  t text;
begin
  foreach t in array array[
    'gates','gate_evaluations','warnings','approvals','interventions'
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
