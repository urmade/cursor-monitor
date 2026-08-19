# Cursor Team API sync

## Credentials

The sync supports either:

1. `CURSOR_ORGANIZATION_API_KEY` and `CURSOR_ORGANIZATION_ID` (preferred), or
2. one or more Team API keys through `CURSOR_TEAM_API_KEY` and/or
   `CURSOR_TEAM_API_KEYS`.

Organization credentials take precedence. When organization mode is configured,
Team keys are ignored.

`CURSOR_TEAM_API_KEYS` accepts comma- or newline-separated values. If both
`CURSOR_TEAM_API_KEY` and `CURSOR_TEAM_API_KEYS` are set, the values are merged
and deduplicated. Each configured Team key is polled independently during a sync;
usage rows still deduplicate by fingerprint across keys.

`CURSOR_API_BASE_URL` defaults to `https://api.cursor.com` and exists only for
controlled API-compatible testing.

The client uses HTTP Basic auth with the API key as the username and an empty
password.

## Endpoints

- Team: `POST /teams/filtered-usage-events`
- Organization: `POST /organizations/filtered-usage-events`

Requests contain `startDate`, `endDate`, `page`, and `pageSize`. Organization
requests also contain `organizationId`.

## Schedule and windows

`apps/web/vercel.json` invokes `/api/cron/sync` every five minutes.

- First successful run: look back seven days.
- Later runs: start one hour before the previous successful run's end.
- End: current server time.
- Page size: 1,000.
- Maximum: 20 pages per requested window.

The one-hour overlap handles delayed or reordered upstream events. Every raw
usage event receives a stable SHA-256 fingerprint, so overlap does not duplicate
database rows or cost.

When a window reaches 20 pages, the sync recursively bisects it down to
five-minute windows. A minimum-size window that still truncates is recorded as
failed and does not advance the successful watermark.

## Concurrency

The configured database adapter holds a ten-minute, owner-scoped lease for the
Team usage source (`monitor_sync_locks` in the default PostgreSQL adapter).
Concurrent invocations return `skipped`. A stale lease can be replaced, and an
old invocation cannot release a newer lease.

## Conversation matching

The Team API does not provide a reliable repository for every usage event.
Cursor Monitor therefore:

1. normalizes the API conversation ID;
2. stores usage independently from hooks;
3. joins usage to the hook conversation with that key;
4. attributes the conversation to the newest hook repository;
5. sums all finite `chargedCents` values for that conversation.

Usage without a matching hook remains stored and appears in the dashboard's
unmatched count. A future hook automatically makes it visible under a project.

## Failure behavior

- Missing credentials produce an auditable `skipped` run.
- `429` and `5xx` responses retry with exponential backoff.
- Each HTTP request has an eight-second timeout and the complete API walk has a
  45-second deadline below the Vercel function limit.
- Authentication and other `4xx` responses fail immediately.
- Errors are bounded before persistence.
- Failed runs do not advance the successful window cursor.
- Hook ingestion is unaffected.

## Manual sync

The Operations page invokes the same `syncTeamUsage()` path as cron. It requires
a Passport admin and respects the same lock.

## Changing the sync

Protocol changes belong in `packages/team-api`. Window and fingerprint creation
belong in `packages/core/src/team-sync.ts`; deduplication, lease, and persistence
semantics are implemented by `packages/db/src/adapter.ts`. Keep these concerns
separate so orchestration and the HTTP client stay testable without a database.
