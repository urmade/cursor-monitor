# Cursor Team API sync

## Credentials

The sync supports either:

1. `CURSOR_ORGANIZATION_API_KEY` and `CURSOR_ORGANIZATION_ID` (preferred), or
2. `CURSOR_TEAM_API_KEY`.

Organization credentials take precedence. `CURSOR_API_BASE_URL` defaults to
`https://api.cursor.com` and exists only for controlled API-compatible testing.

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
- Maximum: 20 pages per invocation.

The one-hour overlap handles delayed or reordered upstream events. Every raw
usage event receives a stable SHA-256 fingerprint, so overlap does not duplicate
database rows or cost.

## Concurrency

`monitor_sync_locks` holds a ten-minute lease for the Team usage source.
Concurrent invocations return `skipped`. A stale lease is deleted before a new
one is acquired.

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
- Authentication and other `4xx` responses fail immediately.
- Errors are bounded before persistence.
- Failed runs do not advance the successful window cursor.
- Hook ingestion is unaffected.

## Manual sync

The Operations page invokes the same `syncTeamUsage()` path as cron. It requires
a Passport admin and respects the same lock.

## Changing the sync

Protocol changes belong in `packages/team-api`. Window, lock, fingerprint
persistence, and database behavior belong in `packages/core/src/team-sync.ts`.
Keep these concerns separate so the HTTP client stays testable without a
database.
