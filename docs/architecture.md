# Architecture

## Goals

Cursor Monitor has one job: correlate immediate local/Cloud Agent hook telemetry
with authoritative Cursor Team usage data, then present it by repository and
conversation.

The application intentionally does not contain project management, work items,
agent launch controls, MCP tools, webhook delivery, or any other orchestration
domain.

## System boundaries

```text
┌──────────────────────┐           ┌──────────────────────┐
│ Cursor IDE / Agent   │           │ Cursor Team API      │
│ project hooks        │           │ filtered usage       │
└──────────┬───────────┘           └──────────┬───────────┘
           │ POST                                 ▲
           ▼                                      │ every 5m
┌────────────────────────────────────────────────────────────┐
│ Next.js application                                       │
│                                                            │
│ /api/hooks/events        /api/cron/sync                    │
│        │                        │                           │
│        ▼                        ▼                           │
│ hook parser              @cursor-monitor/core/team-sync    │
│        │                        │                           │
└────────┼────────────────────────┼───────────────────────────┘
         ▼                        ▼
┌────────────────────────────────────────────────────────────┐
│ Managed Supabase                                          │
│ monitor_hook_events     monitor_team_usage_events          │
│ preferences            monitor_sync_runs / locks           │
└───────────────────────────┬────────────────────────────────┘
                            ▼
                 @cursor-monitor/core/aggregation
                            ▼
                  Dashboard and project pages
```

## Package boundaries

### `packages/team-api`

Knows the Cursor HTTP protocol only. It performs Basic authentication, selects
Team versus Organization endpoints, retries rate limits/transient failures,
paginates, and returns raw usage events. It has no database or UI dependency.

### `packages/db`

Knows Supabase/Postgres persistence only. It exports the Drizzle schema and
runtime connection. It has no product-rule dependency.

### `packages/core`

Owns stable identities, merge validation, project aggregation, usage matching,
sync windows, locks, and deduplicated persistence. It depends on `db` and
`team-api`, never on Next.js.

### `apps/web`

Adapts HTTP and HTML to the domain packages. API handlers authenticate untrusted
requests before calling product code. Server actions authenticate Passport
admins before changing display preferences or starting a manual sync.

## Request paths

### Hook event

1. The installed stop hook reads Cursor JSON from stdin.
2. It enriches the payload with repository, branch, workspace, and paired start
   and finish timestamps.
3. It sends `x-cursor-monitor-token` for app authentication and
   `x-vercel-protection-bypass` for deployment protection.
4. `/api/hooks/events` validates auth and the 256 KiB body limit.
5. The parser preserves the raw payload, stores original repository casing, and
   computes canonical keys.
6. `(generation_id, event_name)` is unique when a generation ID exists, making
   hook retries idempotent.

### Team usage sync

1. Vercel calls `/api/cron/sync` every five minutes with `CRON_SECRET`.
2. A database lease prevents overlapping invocations.
3. The sync starts seven days back on first run, or one hour before the previous
   successful end time on subsequent runs.
4. The client pages the Team or Organization filtered-usage endpoint.
5. A SHA-256 fingerprint of canonical JSON deduplicates overlapping windows.
6. The sync run stores counts, window, paging, truncation, and a bounded error.

### Dashboard read

1. `apps/web/src/server/data.ts` loads bounded recent rows and preferences.
2. `buildMonitorTree()` normalizes case, resolves explicit merge roots, assigns
   each conversation to its newest repository, and joins usage by conversation.
3. Raw events remain unchanged. All renames and repository merges are display
   projections.

## Security model

- Human pages are protected by the internalsphere Vercel Passport boundary.
- Mutating server actions additionally require a valid Passport identity. This
  internal app intentionally treats every approved Passport viewer as an
  administrator; add role checks before broadening its audience.
- Hook requests require an application token and the platform bypass.
- Cron requests require `CRON_SECRET`.
- Team credentials are server-only encrypted secrets.
- Supabase RLS is enabled with no anon/authenticated policies. The server
  connection is the only data path.
- Installer responses are private and non-cacheable because they embed the
  ingestion credential and Vercel bypass.
- Human routes require a Passport identity in the root layout, so possession of
  a hook script cannot expose dashboard telemetry.

## Scale boundaries

The UI reads summary columns for the newest 5,000 hook rows and 10,000 usage
rows. Raw JSON is fetched separately for at most 1,000 project events. It reports
when a limit is reached; historical rows remain queryable in Supabase. Polling
accepts up to 20 pages of 1,000 usage rows per window, recursively splits a
truncated window, and does not advance the successful watermark if a minimum
window still truncates.

If these limits become routine, move dashboard aggregation into materialized
summary tables while preserving the same identity functions and raw event
tables.
