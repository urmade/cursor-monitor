# Cursor Monitor agent guide

This repository contains one standalone product: **Cursor Monitor**. It ingests
Cursor project-hook events, polls Cursor Team/Organization usage events, and
joins both streams by normalized conversation ID.

## Hard rules

### No Slack

Never call Slack tools, APIs, CLIs, or plugins. GitHub pull requests are the
source of truth. If work is blocked, stop and document the blocker in the agent
run or PR.

### No walkthrough media

Never record or upload walkthrough videos or screenshot artifacts. Prove work
with automated tests, build output, logs, and written verification.

### Supabase is the only database

The only database is `integrations.db.type: supabase` in `app-manifest.yml`.
Use `DB_POSTGRES_URL` and `DB_POSTGRES_URL_NON_POOLING`; those names refer to the
managed Supabase integration. Never install or start another Postgres server.
Add schema changes under `packages/db/migrations/` and validate them on the PR
preview deployment.

### Managed platform files

Do not edit policy-managed workflows, `CODEOWNERS`, `.sops.yaml`, git hooks,
`scripts/setup-repo.sh`, `scripts/install-secrets-tooling.sh`,
`scripts/app-manifest.py`, `scripts/secrets-guard.py`, `scripts/secrets.py`,
distributed `.cursor/skills/`, `secrets/inventory.yaml`, or `QUICKSTART.md`.
Never bypass git hooks.

## Architecture at a glance

```text
Cursor project hook ──POST──> apps/web/app/api/hooks/events
                                  │
                                  ▼
                         monitor_hook_events

Vercel cron ──> apps/web/app/api/cron/sync ──> Cursor Team API
                                                   │
                                                   ▼
                                        monitor_team_usage_events

Dashboard ──> apps/web/src/server/data.ts ──> @cursor-monitor/core aggregation
```

Workspace packages have one-way dependencies:

```text
apps/web
  └─ packages/core
       ├─ packages/db
       └─ packages/team-api

packages/db and packages/team-api do not depend on packages/core or apps/web.
```

## Identity invariants

These rules are product behavior, not implementation details:

- Repository identity is `trim().toLowerCase()`. `Acme/App` and `acme/app`
  always resolve to one project.
- Original repository casing is retained on each hook event for diagnostics.
- Explicit repository merges are display-time mappings. Raw hook rows are never
  rewritten.
- Merge chains are transitive and cycles are rejected.
- Conversation identity is the trimmed, lowercased Cursor conversation ID.
- Conversation and repository renames are display preferences. Stable keys,
  URLs, usage joins, and raw payloads never change.
- Team API polling overlaps the previous successful window by one hour. Usage
  event fingerprints make the overlap idempotent.
- Hook ingestion and Team API sync are independent. One may fail without
  preventing the other from storing data.

If a change violates an invariant, update the design documentation and add a
decision record before changing code.

## Where changes belong

| Change | Primary location |
|---|---|
| Repository/conversation normalization | `packages/core/src/identity.ts` |
| Grouping, cost aggregation, merge behavior | `packages/core/src/aggregation.ts` |
| Merge validation | `packages/core/src/preferences.ts` |
| Cursor usage HTTP protocol | `packages/team-api/src/client.ts` |
| Poll cadence/window/deduplication | `packages/core/src/team-sync.ts` |
| Tables/indexes | `packages/db/src/schema/index.ts` + a migration |
| Hook authentication/payload parsing | `apps/web/src/server/hook-ingest.ts` |
| Linux/macOS/Windows installers | `apps/web/src/server/installers.ts` |
| Admin mutations | `apps/web/src/server/actions.ts` |
| Dashboard data loading | `apps/web/src/server/data.ts` |
| UI routes | `apps/web/app/` |

## Commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 scripts/app-manifest.py
```

Database-backed tests must run only when `DB_POSTGRES_URL` already targets the
managed Supabase integration. Otherwise skip them. Never provision a substitute
database.

CI runs migrations through `pnpm db:exec-migrations` before deploying each
preview. Preview/production deploys happen only through the managed PR workflow.

## Making changes safely

1. Read `README.md` and the relevant document under `docs/`.
2. Preserve the identity and idempotency invariants.
3. Add pure tests for normalization, merge, aggregation, and API page behavior.
4. Add a forward-only SQL migration for database changes.
5. Run lint, typecheck, tests, build, and manifest validation.
6. Commit only files related to the requested change; never commit plaintext
   `.env` files or credential values.

See `docs/ai-agent-guide.md` for common change recipes and investigation entry
points.
