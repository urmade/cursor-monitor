# Data model

All tables use the `monitor_` prefix so the standalone product has an explicit
schema boundary. The first schema is in
`packages/db/migrations/0001_cursor_monitor.sql`.

## Identity

### Repository key

`trim().toLowerCase()` of the best available `owner/repository` label. Empty
values remain `NULL` in raw rows and map to `__no_repository__` in the domain
model.

The raw `repository_label` is retained separately, so diagnostics can show what
the hook supplied while product grouping remains case-insensitive.

### Conversation key

`trim().toLowerCase()` of Cursor's conversation ID. Raw IDs are retained.
Missing IDs remain `NULL` and map to `__unknown_conversation__` in memory.

## Tables

### `monitor_hook_events`

Append-only hook telemetry.

- `id`: application-generated UUID
- `event_name`: normally `stop`
- `conversation_id` / `conversation_key`
- `generation_id`: used with `event_name` for retry deduplication
- `repository_label` / `repository_key`
- branch, workspace, user, model, status, duration
- `payload`: complete received JSON
- `occurred_at`: hook finish timestamp or server receipt time
- `received_at`: server receipt time

Indexes support repository and conversation timelines.

### `monitor_team_usage_events`

Deduplicated API telemetry.

- `fingerprint`: versioned SHA-256 identity using an upstream event ID when
  available, otherwise stable conversation/time/user/model/cost/token fields
- `conversation_id` / `conversation_key`
- user, model, kind, team, charged cents
- `payload`: complete API event
- `occurred_at` / `fetched_at`

A conversation's cost is the sum of all finite `charged_cents` values for its
usage events. Cost is not copied onto hook rows.

### `monitor_repository_preferences`

One row per canonical repository.

- `display_name`: optional label only
- `merged_into_key`: optional canonical merge target

Merge roots are resolved transitively. Application validation rejects
self-merges, cycles, and attempts to move a root that still has attached
repositories. The database also rejects direct self-merges.

### `monitor_conversation_preferences`

One display name per canonical conversation. Renaming never changes the Team API
join key or raw IDs.

### `monitor_branch_preferences`

One display name per `(repository_key, branch_key)`. Merged projects use
repository-prefixed branch keys to avoid collisions between identical branch
names in different repositories.

### `monitor_sync_runs`

Audit log for Team API polling:

- status (`running`, `succeeded`, `failed`, `skipped`)
- requested window
- fetched/inserted counts
- page count and truncation
- bounded failure text and timestamps

### `monitor_sync_locks`

Short-lived database lease keyed by sync source. Each lease has a UUID owner, so
a timed-out invocation cannot release its successor's lock. A stale lease
expires after ten minutes and can be replaced.

## Projection rules

1. Sort hook events newest first.
2. Assign each conversation to the merge root of its newest event's repository.
3. Keep all hook events for that conversation together, even if older events
   reported another repository.
4. Join all usage events with the same canonical conversation key.
5. Apply repository, branch, and conversation display labels last.

This order prevents cost duplication when a conversation moves between
repositories and prevents renames from breaking stable identity.

## Migration policy

Migrations are forward-only and applied lexically by
`packages/db/src/exec-migrations.ts` under a Postgres advisory lock. Never modify
an applied migration. Update the Drizzle schema and add a new SQL file together.
