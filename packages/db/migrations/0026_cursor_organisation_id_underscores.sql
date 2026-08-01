-- Cursor organisation ids may contain underscores (for example org_foo_bar).
alter table cursor_organisations
  drop constraint cursor_organisations_organization_id_format;

alter table cursor_organisations
  add constraint cursor_organisations_organization_id_format
  check (
    organization_id is null
    or organization_id ~ '^org_[A-Za-z0-9_]+$'
  );
