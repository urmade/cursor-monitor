-- Org-scoped Monitoring preferences: hide, rename, and merge repositories.
-- Numbered 0031 (main claimed 0030_cursor_stop_hook_cost_lookup). Preview may
-- already have applied the pre-renumber 0030_monitoring_repo_preferences shape —
-- CREATE TABLE / INDEX IF NOT EXISTS keeps re-apply safe. Branch preferences
-- were added after the renumber and must still land on those preview DBs.

create table if not exists monitoring_repo_preferences (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  repo text not null,
  display_name text,
  hidden boolean not null default false,
  merged_into_repo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monitoring_repo_preferences_repo_nonempty
    check (btrim(repo) <> ''),
  constraint monitoring_repo_preferences_display_name_nonempty
    check (display_name is null or btrim(display_name) <> ''),
  constraint monitoring_repo_preferences_merged_into_nonempty
    check (merged_into_repo is null or btrim(merged_into_repo) <> ''),
  constraint monitoring_repo_preferences_no_self_merge
    check (merged_into_repo is null or lower(btrim(merged_into_repo)) <> lower(btrim(repo)))
);

create unique index if not exists monitoring_repo_preferences_org_repo
  on monitoring_repo_preferences (org_id, lower(btrim(repo)));

create index if not exists monitoring_repo_preferences_org
  on monitoring_repo_preferences (org_id);

create index if not exists monitoring_repo_preferences_org_merged_into
  on monitoring_repo_preferences (org_id, lower(btrim(merged_into_repo)))
  where merged_into_repo is not null;

alter table monitoring_repo_preferences enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table monitoring_repo_preferences from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table monitoring_repo_preferences from authenticated;
  end if;
end $$;

-- Display labels for branch groups in a Monitoring project detail view.
-- The original branch key is preserved; display_name is the human label.

create table if not exists monitoring_branch_preferences (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  project_repo text not null,
  branch_key text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monitoring_branch_preferences_project_nonempty
    check (btrim(project_repo) <> ''),
  constraint monitoring_branch_preferences_branch_nonempty
    check (btrim(branch_key) <> ''),
  constraint monitoring_branch_preferences_display_name_nonempty
    check (btrim(display_name) <> '')
);

create unique index if not exists monitoring_branch_preferences_org_project_branch
  on monitoring_branch_preferences (
    org_id,
    lower(btrim(project_repo)),
    lower(btrim(branch_key))
  );

create index if not exists monitoring_branch_preferences_org_project
  on monitoring_branch_preferences (org_id, lower(btrim(project_repo)));

alter table monitoring_branch_preferences enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table monitoring_branch_preferences from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table monitoring_branch_preferences from authenticated;
  end if;
end $$;

-- Drop the stale schema_migrations row from the pre-renumber filename so the
-- ledger matches the files on disk. Safe no-op when that id was never applied.
delete from schema_migrations
where id = '0030_monitoring_repo_preferences';
