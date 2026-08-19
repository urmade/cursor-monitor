# 0003: Use one replaceable database adapter

- Status: Accepted
- Date: 2026-08-19
- Refines: ADR 0002

## Context

ADR 0002 separated the application from Supabase but still described generic
PostgreSQL as the required persistence baseline. Direct Drizzle tables, query
operators, PostgreSQL SQL fragments, and transaction handles also remained in
`packages/core` and `apps/web`. Replacing PostgreSQL therefore required changes
throughout the product.

Organizations adopting Cursor Monitor are expected to choose infrastructure
that fits their environment. They need a stable persistence boundary, but the
product does not need multi-database aggregation, fallback, or routing.

## Decision

- `packages/db/src/adapter.ts` defines a semantic `DatabaseAdapter` contract.
  Product code uses operations such as deduplicated event insertion, preference
  updates, sync leases, and bounded reads rather than SQL or generic CRUD.
- PostgreSQL remains the shipped default adapter. Its Drizzle schema, postgres.js
  client, advisory locks, connection aliases, and SQL migrations are internal to
  `packages/db`.
- `DATABASE_ADAPTER` selects exactly one adapter and defaults to `postgres`.
  `DATABASE_URL` configures one logical database for the selected adapter.
  Runtime initialization rejects a second adapter or configuration in the same
  process.
- The runtime and migration command use the same immutable adapter catalog.
  There is no automatic fallback when an adapter is unknown or unavailable.
- Replacement adapters must preserve hook and usage deduplication, repository
  merge serialization, sync lease ownership and expiry, ordering, bounded reads,
  timestamp behavior, and migration atomicity.
- Database credentials remain server-only and are never included in Cursor hook
  installers or payloads.

## Consequences

Benefits:

- Organizations can replace PostgreSQL without modifying core orchestration,
  web routes, or hook behavior.
- Backend-specific clients, queries, transactions, locks, and migrations have
  one ownership boundary.
- A single selector and singleton prevent accidental in-process multi-database
  operation.
- Tests can inject a backend-neutral adapter stub.

Trade-offs:

- The adapter is deliberately a product-specific interface rather than a
  universal query layer. Each backend must implement all required semantics.
- Switching database engines is an explicit data migration and deployment
  cutover. The product does not dual-write during migration.
- One process-level singleton cannot coordinate old and new deployment revisions
  during a rolling cutover; operators must quiesce writers before switching.
- The reference `app-manifest.yml` still provisions one Supabase PostgreSQL
  resource for internalsphere, but that remains a deployment choice.
