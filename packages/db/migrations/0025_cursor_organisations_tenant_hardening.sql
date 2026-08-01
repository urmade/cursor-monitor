-- Tenant consistency + revoke/reattach uniqueness for Cursor organisation credentials.

-- Composite FK targets: (id, org_id) must be uniquely addressable.
create unique index if not exists users_id_org_id_uidx on users (id, org_id);
create unique index if not exists cursor_organisations_id_org_uidx
  on cursor_organisations (id, org_id);

-- Credential rows are user-managed; disallow unowned/orphaned records.
alter table cursor_organisations
  alter column created_by_user_id set not null;

alter table cursor_organisation_api_keys
  alter column created_by_user_id set not null;

-- api key.org_id must match its parent cursor_organisations.org_id
alter table cursor_organisation_api_keys
  add constraint cursor_organisation_api_keys_org_consistency_fk
  foreign key (cursor_organisation_id, org_id)
  references cursor_organisations (id, org_id)
  on delete cascade;

-- created_by_user_id (when set) must belong to the same nexus org
alter table cursor_organisations
  add constraint cursor_organisations_created_by_org_fk
  foreign key (created_by_user_id, org_id)
  references users (id, org_id);

alter table cursor_organisation_api_keys
  add constraint cursor_organisation_api_keys_created_by_org_fk
  foreign key (created_by_user_id, org_id)
  references users (id, org_id);

-- Allow reattaching a previously revoked fingerprint (active rows only).
alter table cursor_organisation_api_keys
  drop constraint if exists cursor_organisation_api_keys_cursor_organisation_id_api_key_key;

drop index if exists cursor_organisation_api_keys_fp;

create unique index cursor_organisation_api_keys_fp_active
  on cursor_organisation_api_keys (cursor_organisation_id, api_key_fingerprint)
  where revoked_at is null;
