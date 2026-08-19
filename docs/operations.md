# Operations

## Deployment

Every deployment must run `pnpm db:exec-migrations` before starting `apps/web`.
This command migrates the one adapter selected by `DATABASE_ADAPTER`. The
reference internalsphere deployment does this through the managed GitHub
workflow: a PR provisions its PostgreSQL-compatible Supabase resource, applies
migrations, and deploys the app.

Other deployments may replace the default adapter and use their own deployment
tooling. See `docs/database-adapters.md`.

## Database configuration

`DATABASE_ADAPTER` selects one adapter and defaults to `postgres`. It accepts one
exact ID, not a list. The runtime never falls back to another adapter and rejects
a second adapter or logical database configuration in the same process.

Set `DATABASE_URL` to the selected adapter's server-only runtime connection.
`MIGRATION_DATABASE_URL` optionally supplies its migration connection. These
variables describe one logical database, not separate data sources.

For the default PostgreSQL adapter, provider names are resolved in this order:

1. `DATABASE_URL`
2. `POSTGRES_URL`
3. `DB_POSTGRES_URL`

Set `MIGRATION_DATABASE_URL` when migrations need a direct connection instead of
the pooled runtime URL. Migration aliases are
`DATABASE_URL_NON_POOLING`, `POSTGRES_URL_NON_POOLING`, and
`DB_POSTGRES_URL_NON_POOLING`. Each alias is paired with its runtime family so a
legacy provider URL cannot override a selected `DATABASE_URL`; migration
execution falls back to the selected runtime URL when its matching direct value
is not configured.

Remote connections require TLS by default. A connection-string `sslmode` takes
precedence. Standard `PGSSLMODE` values are supported; `verify-full` preserves
certificate and hostname verification, while the application tightens
`verify-ca` to `verify-full`. Use `disable` only for a database that explicitly
does not support TLS. `DB_SSL` remains as a legacy alias. Localhost connections
default to TLS disabled.

The default adapter's migration identity must be able to create and alter tables
and take a PostgreSQL advisory lock. If a separate runtime identity is used,
grant it read/write access to the `monitor_*` tables and configure RLS policies
(or deliberately disable RLS) for that identity. The app does not require
Supabase roles, extensions, or APIs. Replacement adapters document equivalent
permissions and locking requirements.

## Secrets

Use `scripts/secrets.py`; never place values in source, PR text, terminal logs,
or committed `.env` files.

```bash
python3 scripts/secrets.py list --scope remote --env production
python3 scripts/secrets.py add --scope shared --key CURSOR_MONITOR_HOOK_TOKEN
python3 scripts/secrets.py update --scope shared --key CURSOR_TEAM_API_KEY
python3 scripts/secrets.py update --scope shared --key CRON_SECRET
```

Supported keys:

| Key | Required | Notes |
|---|---|---|
| `CURSOR_MONITOR_HOOK_TOKEN` | Yes | Dedicated inbound app token; see `docs/hooks.md` |
| `CRON_SECRET` | Vercel cron only | Authorizes scheduled `/api/cron/sync`; omit locally |
| `CURSOR_TEAM_API_KEY` | Team mode | One Team API key |
| `CURSOR_TEAM_API_KEYS` | Team mode | Additional comma/newline-separated Team keys |
| `CURSOR_ORGANIZATION_API_KEY` | One credential mode | Pair with organization ID |
| `CURSOR_ORGANIZATION_ID` | Organization mode | Required with organization key |
| `CURSOR_API_BASE_URL` | No | Defaults to official Cursor API |

In the reference deployment, `DB_*` values are injected by `integrations.db`;
do not duplicate them as manual secrets. Other deployments should store the one
selected adapter ID and its connection values in their platform secret manager.

## Health surfaces

### `/api/health`

Returns `200` when the database is reachable and `503` otherwise. It never
returns credential values.

### `/settings`

Shows configuration presence and the ten latest Team API sync attempts,
including windows, paging, inserted rows, truncation, and errors.

### Dashboard

Shows unmatched Team usage and warns when read safety limits truncate the
current projection.

### Local hook log

`~/.cursor/cursor-monitor/hook.log` records one line per POST attempt.

## Common incidents

### Hooks return 401

Download and re-upload the direct stop script after verifying
`CURSOR_MONITOR_HOOK_TOKEN`. Previously generated scripts retain the old
credential.

### Hooks never reach the app

Verify the endpoint embedded in the Team Hook script and the local hook log. A
preview script posts to preview and therefore writes to the preview database.

### Cron returns 401 or 503

`CRON_SECRET` is required only for automated Vercel cron invocations. Vercel
sends it as a Bearer token. Local development does not need it; use Operations →
Sync now or call the route manually with the same header. A missing secret returns
`503 cron_not_configured`; a wrong token returns `401`.

### Team sync returns 401/403

Verify the credential mode and endpoint. Organization credentials require both
key and organization ID. Team credentials may not have access to filtered usage
on every plan.

### Sync always skips as running

The lock expires after ten minutes. If no run is active and the row remains,
inspect the configured adapter's sync lease storage (`monitor_sync_locks` in the
default PostgreSQL adapter) and compare its expiry. Normal syncs release the
lease in `finally`.

### Costs appear pending

Check the unmatched usage count and sync history. Hook and Team API conversation
IDs must normalize to the same value. Inspect raw payloads in the project event
details and `monitor_team_usage_events`.

## Rotation order

For zero-downtime hook token rotation:

1. update the encrypted secret and deploy;
2. download fresh stop scripts for the Team Hook operating systems;
3. replace the centrally managed Team Hook scripts.

Old hooks begin returning 401 after step 1. If uninterrupted ingestion is
mandatory, add dual-token support in a reviewed change before rotation.

## Retention

The initial schema does not delete raw events. Add retention only with an
explicit decision record and separate raw versus aggregate requirements.
