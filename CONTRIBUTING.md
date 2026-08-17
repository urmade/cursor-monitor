# Contributing to Cursor Monitor

## Local setup

```bash
sh scripts/setup-repo.sh
pnpm install
pnpm dev
```

Local pages that read Supabase require `DB_POSTGRES_URL`. Do not create a local
database. Database-backed behavior is validated on the PR preview deployment,
where the managed Supabase integration is available.

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
- `packages/db`: Supabase connection, schema, and forward-only migrations.
- `packages/config`: shared TypeScript and lint configuration.

Keep product logic out of React components. Pure identity and grouping behavior
belongs in `packages/core` and requires unit tests.

## Schema changes

1. Update `packages/db/src/schema/index.ts`.
2. Add a new, forward-only SQL file to `packages/db/migrations/`.
3. Do not edit an applied migration.
4. Push the branch and verify migration/deploy checks on the PR preview.

CI invokes `pnpm db:exec-migrations` against the environment's managed Supabase
database before deploy.

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
- preview checks needed for Supabase, hooks, or Team API behavior.
