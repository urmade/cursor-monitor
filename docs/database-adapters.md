# Database adapter guide

Cursor Monitor ships with PostgreSQL, but persistence is replaceable. A
deployment selects exactly one adapter and one database. The application does
not aggregate, fall back across, dual-read, or dual-write multiple databases.

## Layout

```text
packages/db/src/
  adapter.ts              Backend-neutral records and DatabaseAdapter contract
  runtime.ts              Immutable adapter catalog and single-instance selector
  postgres-adapter.ts     Default semantic operation implementation
  client.ts               Internal postgres.js/Drizzle connection
  schema/index.ts         Internal PostgreSQL schema
  postgres-migrations.ts  Default migration runner
  exec-migrations.ts      Selected-adapter migration entry point
  testing.ts              Adapter stub for unit tests
```

Only neutral types and `getDatabase()` are exported from `@cursor-monitor/db`.
`packages/core` and `apps/web` must not import Drizzle, a schema table, a driver
client, or an adapter implementation.

## Selection and configuration

`DATABASE_ADAPTER` is one exact adapter ID. It defaults to `postgres`. Lists such
as `postgres,mysql` are rejected.

`DATABASE_URL` belongs to the selected adapter. The optional
`MIGRATION_DATABASE_URL` is its direct migration connection. An adapter may
support provider aliases, but aliases must resolve to the same logical database;
they are not extra data sources.

`packages/db/src/runtime.ts` keeps one adapter instance and a non-secret
connection fingerprint on `globalThis`. Requesting another adapter or connection
in the same process fails instead of opening a second database.

## Required semantics

Every replacement adapter must preserve:

1. Hook inserts are idempotent for a non-null
   `(generationId, eventName)` pair. Null generation IDs remain independently
   insertable.
2. Team usage inserts deduplicate by fingerprint and return the number of newly
   inserted events.
3. Repository merge validation and its write are serialized and atomic.
4. Sync leases have one winner, expire after the supplied timestamp, and can be
   released only by their owner.
5. Only successful sync runs advance the polling watermark.
6. Recent event and sync reads honor their requested ordering and limits.
7. IDs, raw JSON, nullable values, finite costs, and UTC timestamps round-trip
   without changing product identity.
8. Migrations are forward-only, exclusively locked, and journaled atomically
   where the backend supports transactional schema changes.
9. `ping()` never exposes credentials, and `close()` is idempotent.

If a backend cannot provide equivalent semantics, it is not a compatible
adapter.

## Replacing PostgreSQL

1. Add an implementation of `DatabaseAdapter` under `packages/db/src/`.
   Keep its SDK, queries, schema, and transaction primitives in that package.
2. Add an adapter factory to the immutable catalog in `runtime.ts`. The factory
   provides a stable ID, display name, configuration fingerprint, runtime
   instance, and migration function.
3. Make the adapter read the canonical `DATABASE_URL` and
   `MIGRATION_DATABASE_URL`. Add only aliases needed by that backend.
4. Route `pnpm db:exec-migrations` to the adapter's own migration runner. Do not
   reuse PostgreSQL SQL for another engine.
5. Use `createDatabaseAdapterStub()` from `@cursor-monitor/db/testing` for core
   and web unit tests. Add adapter-specific configuration and integration tests.
6. Update `docs/operations.md` with connection, migration, locking, backup, and
   troubleshooting details for the backend.
7. Run lint, typecheck, tests, build, and manifest validation. On a
   non-production test deployment, verify migrations, `/api/health`, one hook
   insert and retry, two overlapping usage syncs, preference updates, and lease
   expiry.

Adding a factory makes an adapter available; it does not activate multiple
databases. Each deployment still chooses one ID.

## Switching an existing deployment

Changing adapter IDs is a data migration, not an application fallback:

1. stop hook ingestion and scheduled/manual sync writers;
2. export and transform all raw events, preferences, sync history, and stable
   IDs;
3. migrate and validate the destination database;
4. update the one adapter selection and its one connection;
5. deploy, verify health and counts, then resume writers.

Do not implement temporary dual writes in the runtime adapter. A separately
reviewed migration tool may read a source and write a destination while the
application is quiesced.

## Hook boundary

Hooks POST to the application HTTP endpoint. Database adapter IDs, URLs, driver
options, and credentials must never appear in generated installers, hook
environment variables, payloads, logs, or responses.
