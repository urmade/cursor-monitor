# Cursor Monitor

Cursor Monitor is a standalone internal application for understanding Cursor
request activity by repository, branch, and conversation.

It combines two independent data streams:

1. **Cursor project hooks** publish a completed request immediately, including
   repository, branch, user, model, status, and duration.
2. **Cursor Team or Organization API polling** fetches authoritative usage and
   charged-cost events every five minutes.

The streams join on a normalized Cursor conversation ID. Hook delivery remains
useful when the Team API is delayed or unavailable, and Team API events remain
stored when their matching hook has not arrived yet.

## Product behavior

- Repositories that differ only by letter case are one project.
- Administrators can attach multiple repositories to one project without
  rewriting raw events.
- Repository, branch, and individual conversation display names are editable.
- Conversation costs are computed from deduplicated Team API events.
- Linux, macOS, and Windows hook installers are generated from the deployed app.
- Sync status, configuration readiness, unmatched usage, and ingestion failures
  are visible without reading server logs.

## Quick start

```bash
pnpm install
pnpm dev
```

The app is deployed through the managed internalsphere PR workflow. The database
is the existing `db` Supabase integration from `app-manifest.yml`; do not run a
substitute database locally.

Required production settings:

| Setting | Purpose |
|---|---|
| `DB_POSTGRES_URL` | Managed Supabase runtime connection |
| `DB_POSTGRES_URL_NON_POOLING` | Direct migration connection |
| `CRON_SECRET` | Authenticates the five-minute Vercel cron |
| `CURSOR_MONITOR_HOOK_TOKEN` | Authenticates incoming project-hook events |
| `VERCEL_PROTECTION_BYPASS` | Allows hooks through deployment protection |
| `CURSOR_TEAM_API_KEY` | Team usage polling |
| `CURSOR_ORGANIZATION_API_KEY` + `CURSOR_ORGANIZATION_ID` | Preferred Organization API alternative |

When `CURSOR_MONITOR_HOOK_TOKEN` is absent, the app uses
`VERCEL_PROTECTION_BYPASS` as the ingestion token so an existing deployment can
be migrated without a dead period. A separate hook token is recommended.

## Repository map

```text
apps/web/                    Next.js application and API routes
  app/                       Dashboard, repository, installer, operations pages
  src/server/actions.ts      Admin mutations
  src/server/data.ts         Database-to-domain adapters
  src/server/hook-ingest.ts  Hook auth and payload parsing
  src/server/installers.ts   Linux/macOS/Windows generators

packages/core/               Product rules and orchestration
  src/identity.ts            Stable repository/conversation keys
  src/preferences.ts         Merge validation and root resolution
  src/aggregation.ts         Dashboard project/conversation model
  src/team-sync.ts           Poll windows, locking, and persistence

packages/team-api/           Cursor usage API HTTP client
packages/db/                 Drizzle schema, Supabase client, migrations
packages/config/             Shared TypeScript and ESLint configuration
```

## Documentation

- `docs/architecture.md` — boundaries and end-to-end data flow
- `docs/data-model.md` — tables, keys, indexes, and invariants
- `docs/hooks.md` — platform installers and hook operations
- `docs/team-api-sync.md` — polling, paging, overlap, and matching
- `docs/operations.md` — secrets, health checks, failure recovery
- `docs/ai-agent-guide.md` — code exploration and common modification recipes
- `docs/decisions/0001-standalone-monitor.md` — architectural decision record

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 scripts/app-manifest.py
```

See `CONTRIBUTING.md` and `AGENTS.md` before making changes.
