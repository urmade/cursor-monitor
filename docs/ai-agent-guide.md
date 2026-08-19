# AI agent guide

This guide is optimized for administrators who ask an AI coding agent to modify
Cursor Monitor.

## Start here

Tell the agent to read:

1. `AGENTS.md`
2. `README.md`
3. the relevant document under `docs/`
4. the smallest source file listed below

Avoid asking an agent to search the entire repository before reading the
identity invariants in `AGENTS.md`.

## Investigation entry points

| Question | First file |
|---|---|
| Why are two repos one project? | `packages/core/src/identity.ts` |
| Why did a merge resolve here? | `packages/core/src/preferences.ts` |
| Why is a cost/project total wrong? | `packages/core/src/aggregation.ts` |
| Why did polling skip/fail/duplicate? | `packages/core/src/team-sync.ts` |
| Is the Cursor request correct? | `packages/team-api/src/client.ts` |
| Why was a hook rejected? | `apps/web/src/server/hook-ingest.ts` |
| How is a Team Hook script generated? | `apps/web/src/server/hook-scripts.ts` |
| Where does a rename write? | `apps/web/src/server/actions.ts` |
| How are rows loaded into the UI? | `apps/web/src/server/data.ts` |
| What persistence operation owns a field? | `packages/db/src/adapter.ts` |
| What PostgreSQL table/index owns a field? | `packages/db/src/schema/index.ts` |
| How do I replace the database? | `docs/database-adapters.md` |

## Common change recipes

### Add a field from hook payload to the UI

1. Add the field to the database adapter contract.
2. Add it to the default PostgreSQL schema and a forward-only migration.
3. Parse it in `hook-ingest.ts`.
4. Include it in the adapter insert input.
5. Add it to `MonitorHookRecord`.
6. Map it in `data.ts`.
7. Render it on the repository page.
8. Test parsing and aggregation separately.

Do not remove the value from raw `payload`.

### Change repository grouping

1. Write a failing pure test in `packages/core/src/monitoring.test.ts`.
2. Change `identity.ts` or `preferences.ts`.
3. Verify case variants, no-repository behavior, merge cycles, and URLs.
4. Update `AGENTS.md`, `data-model.md`, and an ADR if stable identity changes.

Never solve grouping by rewriting historical raw events.

### Add a Cursor Team API filter/field

1. Update request/response types in `packages/team-api/src/types.ts`.
2. Change only protocol behavior in `packages/team-api/src/client.ts`.
3. Add a mocked pagination/request test.
4. Map persistence in `packages/core/src/team-sync.ts`.
5. Add a schema migration if storage changes.

### Change a Team Hook script

1. Change only `apps/web/src/server/hook-scripts.ts`.
2. Keep stop-hook failures non-blocking.
3. Keep Linux/macOS POSIX-compatible; do not introduce Bash-only arrays.
4. Keep Windows compatible with Windows PowerShell 5.1 unless the support policy
   is deliberately changed.
5. Do not introduce Python, Node, `jq`, package managers, or third-party modules.
6. Update script tests and `docs/hooks.md`.

### Replace the database adapter

Follow `docs/database-adapters.md`. Keep exactly one selected backend, preserve
all semantic operations in `DatabaseAdapter`, route migrations through
`pnpm db:exec-migrations`, and do not expose provider code outside `packages/db`.

### Replace the database adapter

Follow `docs/database-adapters.md`. Keep exactly one selected backend, preserve
all semantic operations in `DatabaseAdapter`, route migrations through
`pnpm db:exec-migrations`, and do not expose provider code outside `packages/db`.

### Add a dashboard preference

Display-only preferences need:

1. a preference table/column and migration;
2. an authenticated server action;
3. application in `buildMonitorTree()` after stable identity;
4. a native form in the UI;
5. a pure test proving stable keys do not change.

## Verification expectations

Agents should run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 scripts/app-manifest.py
```

Database behavior is validated against an explicitly configured development or
preview instance for the selected adapter. The strongest checks are:

- migration succeeded;
- `/api/health` returns `200`;
- Operations shows configured sources;
- a real generated hook returns `200`;
- a manual Team sync creates a successful run;
- a conversation cost appears without duplication after a second sync.

## Review checklist

- Does the change preserve canonical repository and conversation keys?
- Can a retry create duplicate hook or usage rows?
- Is every external request authenticated and bounded?
- Does a failed external request leave a stale lock or block hook ingestion?
- Are secrets absent from source, tests, logs, and PR text?
- Is raw source data retained when display behavior changes?
- Does a schema change update the neutral contract and the selected adapter's
  schema and forward migration?
- Can a new admin find the change through `README.md` or this guide?
