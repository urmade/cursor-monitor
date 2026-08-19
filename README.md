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
- Sync status, configuration readiness, unmatched usage, and stored hook totals
  are visible without reading server logs; client-side delivery failures remain
  in the local hook log.

## Quick start

```bash
pnpm install
DATABASE_URL=postgresql://user:password@host:5432/database pnpm db:exec-migrations
DATABASE_URL=postgresql://user:password@host:5432/database pnpm dev
```

Use a secret manager or uncommitted local environment file instead of placing a
real connection string in source or shared shell history. PostgreSQL is the
default adapter, so an unset `DATABASE_ADAPTER` is equivalent to `postgres`.
Its `DATABASE_URL` accepts any standards-compatible PostgreSQL connection. If
the runtime URL is pooled, set `MIGRATION_DATABASE_URL` to a direct connection
before running migrations.

Organizations may replace PostgreSQL by implementing the semantic contract in
`packages/db`. A deployment always selects one adapter and one database; the app
does not query or synchronize multiple databases.

The reference internalsphere deployment still provisions the `db` Supabase
integration from `app-manifest.yml`. Its `DB_POSTGRES_URL` and
`DB_POSTGRES_URL_NON_POOLING` values are backward-compatible provider aliases,
not application requirements.

Required production settings:

| Setting | Purpose |
|---|---|
| `DATABASE_ADAPTER` | One adapter ID; defaults to `postgres` |
| `DATABASE_URL` | Selected adapter's runtime connection |
| `MIGRATION_DATABASE_URL` | Optional selected-adapter migration connection |
| `CRON_SECRET` | Authenticates the five-minute Vercel cron |
| `CURSOR_MONITOR_HOOK_TOKEN` | Authenticates incoming project-hook events |
| `CURSOR_MONITOR_PUBLIC_URL` | Stable public URL embedded in fresh hook installers |
| `VERCEL_PROTECTION_BYPASS` | Allows hooks through deployment protection |
| `CURSOR_TEAM_API_KEY` | Team usage polling |
| `CURSOR_ORGANIZATION_API_KEY` + `CURSOR_ORGANIZATION_ID` | Preferred Organization API alternative |

The hook token and Vercel bypass are deliberately separate. Possession of an
ingestion token permits event submission but does not grant access to human
routes, which also require a Passport identity in the application.

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
packages/db/                 Neutral adapter contract and default PostgreSQL adapter
packages/config/             Shared TypeScript and ESLint configuration
```

## Documentation

- `docs/architecture.md` — boundaries and end-to-end data flow
- `docs/data-model.md` — tables, keys, indexes, and invariants
- `docs/hooks.md` — platform installers and hook operations
- `docs/team-api-sync.md` — polling, paging, overlap, and matching
- `docs/operations.md` — secrets, health checks, failure recovery
- `docs/database-adapters.md` — replace the default persistence adapter
- `docs/ai-agent-guide.md` — code exploration and common modification recipes
- `docs/decisions/0001-standalone-monitor.md` — architectural decision record
- `docs/decisions/0002-generic-postgres-baseline.md` — database portability
- `docs/decisions/0003-single-database-adapter.md` — adapter boundary

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 scripts/app-manifest.py
```

See `CONTRIBUTING.md` and `AGENTS.md` before making changes.
