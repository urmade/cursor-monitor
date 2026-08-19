# 0002: Make generic PostgreSQL the persistence baseline

- Status: Accepted
- Date: 2026-08-19
- Supersedes: the Supabase-only constraint in ADR 0001
- Refined by: [ADR 0003](./0003-single-database-adapter.md)

## Context

Cursor Monitor is intended to be adopted and customized by organizations with
different infrastructure. The original deployment used the existing
internalsphere Supabase integration and treated that deployment choice as a
product invariant. Although the runtime already used PostgreSQL through
postgres.js and Drizzle, its environment contract, documentation, row security,
and agent policy were described and constrained as Supabase-specific.

Project hooks are HTTP clients. They should know the application endpoint and
ingestion token, but they must never receive database credentials or depend on
the selected database provider.

## Decision

- Generic PostgreSQL is the default persistence adapter, not a product
  requirement.
- `DATABASE_URL` is the canonical runtime connection string.
- `MIGRATION_DATABASE_URL` optionally supplies a direct migration connection;
  migrations otherwise use the runtime URL.
- Existing `POSTGRES_*` and `DB_POSTGRES_*` aliases remain supported so current
  managed deployments continue to work without secret migration.
- The schema must not depend on Supabase roles, extensions, APIs, or client
  libraries. Application authentication remains the data-access boundary.
- The Supabase entry in `app-manifest.yml` remains the reference internalsphere
  deployment only and may be replaced by adopters.
- Replacement database implementations belong behind `packages/db` and must
  preserve identity, locking, transaction, and idempotency behavior. Each
  deployment configures one adapter and one database.
- Generated hooks derive their HTTP endpoint from the running app. Changing a
  database connection does not require hook changes, and no database value may
  be embedded in a Team Hook script.

## Consequences

Benefits:

- Any standards-compatible PostgreSQL service can run the default adapter from a
  connection URL.
- Existing internalsphere preview and production deployments remain compatible.
- Provider-specific deployment choices do not leak into product or hook code.
- Other persistence backends may replace PostgreSQL behind a defined package
  boundary without enabling multi-database operation.

Trade-offs:

- Operators using separate migration and runtime roles must grant the runtime
  role access to the `monitor_*` tables and sequences.
- Provider-specific security features such as RLS must be configured by the
  adopting organization rather than assumed by the baseline schema.
- Installed hook files still require regeneration or centrally managed runtime
  overrides when the public application URL or hook token changes. Database
  changes alone do not affect them.
