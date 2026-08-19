# Contributing to Cursor Monitor

## Local setup

```bash
sh scripts/setup-repo.sh
pnpm install
DATABASE_URL=postgresql://user:password@host:5432/database pnpm db:exec-migrations
DATABASE_URL=postgresql://user:password@host:5432/database pnpm dev
```

Database-backed pages require one selected adapter and its connection.
PostgreSQL is the default, using `DATABASE_URL` or a supported provider alias.
Use a dedicated development database and never commit its connection string.
The reference PR preview uses the managed Supabase integration through the
backward-compatible `DB_POSTGRES_*` aliases.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 scripts/app-manifest.py
```

The pre-commit and pre-push hooks run the secrets guard. Do not bypass them.

## Code organization

- `apps/web`: Next.js routes, server actions, installer generation, and UI.
- `packages/core`: product invariants, aggregation, and Team API sync.
- `packages/team-api`: isolated Cursor HTTP client and response types.
- `packages/db`: neutral adapter contract and default PostgreSQL implementation.
- `packages/config`: shared TypeScript and lint configuration.

Keep product logic out of React components. Pure identity and grouping behavior
belongs in `packages/core` and requires unit tests.

## Schema changes

1. Update the neutral records and operations in `packages/db/src/adapter.ts`.
2. For the default adapter, update `packages/db/src/schema/index.ts` and add a
   forward-only SQL file under `packages/db/migrations/`.
3. For a replacement adapter, update its physical schema and forward migration
   together as described in `docs/database-adapters.md`.
4. Do not edit an applied migration.
5. Push the branch and verify migration/deploy checks on the PR preview.

Every deployment must invoke `pnpm db:exec-migrations` for its selected adapter
before starting the app. The reference CI does this against its managed
PostgreSQL resource.

## Secrets

Never commit plaintext credentials. Use the managed CLI:

```bash
python3 scripts/secrets.py list --scope remote --env preview
python3 scripts/secrets.py add --scope shared --key CURSOR_MONITOR_HOOK_TOKEN
python3 scripts/secrets.py update --scope shared --key CURSOR_TEAM_API_KEY
```

See `docs/operations.md` for all supported settings.

## Pull requests

Describe:

- the user-visible behavior;
- any identity, merge, or deduplication invariant affected;
- commands run locally;
- preview checks needed for the configured database adapter, hooks, or Team API
  behavior.
