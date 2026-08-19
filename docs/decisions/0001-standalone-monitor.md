# 0001: Build monitoring as an independent application

- Status: Accepted
- Date: 2026-08-17

The database-provider constraints in this decision are superseded by
[ADR 0002](./0002-generic-postgres-baseline.md).

## Context

Repository and conversation monitoring was previously embedded in a broader
application. Its data model, identity, credentials, UI package, generic job
queue, and navigation inherited unrelated product concepts. The monitoring
feature also lacked a Windows hook and individual conversation names.

The new product must ingest hooks immediately, poll Cursor usage periodically,
preserve case-insensitive repository behavior, support explicit merges and
renames, and remain easy for administrators and AI coding agents to modify.

## Decision

Replace the deployable product on this branch with one standalone Cursor Monitor
application.

- Keep only the internalsphere-managed repository shell and the existing
  Supabase integration.
- Use new `@cursor-monitor/*` packages with no imports from the previous product.
- Use new `monitor_*` tables rather than relying on previous tables.
- Store hook and Team API events independently and join them in a domain
  projection by canonical conversation ID.
- Replace the generic job queue with one authenticated five-minute cron route
  and a narrow database lease.
- Treat repository, branch, and conversation names and repository merges as
  display preferences; never rewrite source events.
- Generate project-hook installers for Linux, macOS, and Windows without
  package-manager or language-runtime dependencies.
- Document file ownership, invariants, operational behavior, and common AI-agent
  change recipes in the repository.

## Consequences

Benefits:

- Product boundaries and failure modes are substantially smaller.
- Hook ingestion remains available during Team API failures.
- Overlapping polling is idempotent and auditable.
- Stable identity is tested independently of the UI and database.
- Windows administrators receive first-class installation support.
- Administrators can rename individual conversations.

Trade-offs:

- Existing raw product tables remain unused in the shared Supabase database
  until a separately reviewed retention/removal decision.
- The dashboard currently projects bounded recent raw rows in application
  memory; sustained high volume will require summary tables.
- Generic Linux requires the distribution-provided `curl`, because POSIX does
  not include a native HTTPS client.
- Generated installers embed an ingestion credential and must be treated as
  private configuration.

## Rejected alternatives

- Continue importing previous domain/UI/job packages: violates standalone
  ownership and preserves unrelated coupling.
- Copy usage cost onto each hook turn: risks double counting and makes retries
  destructive. Conversation-level joins keep source records immutable.
- Poll without overlap: misses delayed upstream usage events.
- Run multiple database backends concurrently: unsupported because each
  deployment selects one persistence adapter and one database.
