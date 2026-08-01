-- Cursor organisation connections + multiple team API keys (encrypted at rest).
-- Cloud Agents can only be listed in a user / service-account key context, so
-- each Nexus org may attach many keys to one Cursor organisation.

create table cursor_organisations (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  label text not null,
  organization_id text,
  base_url text not null,
  org_api_key_encrypted text,
  org_api_key_fingerprint text,
  org_api_key_hint text,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cursor_organisations_organization_id_format
    check (
      organization_id is null
      or organization_id ~ '^org_[A-Za-z0-9]+$'
    )
);

create index cursor_organisations_org on cursor_organisations (org_id, created_at desc);

create unique index cursor_organisations_org_cursor_id
  on cursor_organisations (org_id, organization_id)
  where organization_id is not null;

create table cursor_organisation_api_keys (
  id uuid primary key,
  cursor_organisation_id uuid not null
    references cursor_organisations(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  label text not null,
  key_kind text not null check (key_kind in ('user', 'service_account')),
  api_key_encrypted text not null,
  api_key_fingerprint text not null,
  api_key_hint text not null,
  identity_label text,
  created_by_user_id uuid references users(id),
  last_validated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cursor_organisation_id, api_key_fingerprint)
);

create index cursor_organisation_api_keys_org
  on cursor_organisation_api_keys (org_id, created_at desc);

create index cursor_organisation_api_keys_active
  on cursor_organisation_api_keys (cursor_organisation_id, created_at desc)
  where revoked_at is null;

alter table cursor_organisations enable row level security;
alter table cursor_organisation_api_keys enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table cursor_organisations from anon;
    revoke all on table cursor_organisation_api_keys from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table cursor_organisations from authenticated;
    revoke all on table cursor_organisation_api_keys from authenticated;
  end if;
end $$;
