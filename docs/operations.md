# Operations

## Deployment

Every deployment must run `pnpm db:exec-migrations` before starting `apps/web`.
The reference internalsphere deployment does this through the managed GitHub
workflow: a PR provisions its PostgreSQL-compatible Supabase resource, applies
migrations, and deploys the app.

Other deployments may use any standards-compatible PostgreSQL service and their
own deployment tooling.

## Database configuration

Set `DATABASE_URL` to the server-only PostgreSQL runtime connection. Existing
provider names are resolved in this order:

1. `DATABASE_URL`
2. `POSTGRES_URL`
3. `DB_POSTGRES_URL`

Set `MIGRATION_DATABASE_URL` when migrations need a direct connection instead of
the pooled runtime URL. Migration aliases are
`DATABASE_URL_NON_POOLING`, `POSTGRES_URL_NON_POOLING`, and
`DB_POSTGRES_URL_NON_POOLING`; migration execution falls back to the runtime URL
when none is configured.

Remote connections require TLS by default. A connection-string `sslmode` takes
precedence; `PGSSLMODE=disable` is available for a database that explicitly does
not support TLS. `DB_SSL=disable` remains as a legacy alias. Localhost
connections default to TLS disabled.

The migration identity must be able to create and alter tables and take a
PostgreSQL advisory lock. If a separate runtime identity is used, grant it
read/write access to the `monitor_*` tables. The app does not require Supabase
roles, extensions, or APIs.

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
| `CURSOR_MONITOR_HOOK_TOKEN` | Yes | Dedicated inbound app token |
| `VERCEL_PROTECTION_BYPASS` | Yes for protected deployments | Deployment protection only |
| `CRON_SECRET` | Yes | Vercel cron authorization |
| `CURSOR_TEAM_API_KEY` | One credential mode | Team filtered usage |
| `CURSOR_ORGANIZATION_API_KEY` | One credential mode | Pair with organization ID |
| `CURSOR_ORGANIZATION_ID` | Organization mode | Required with organization key |
| `CURSOR_API_BASE_URL` | No | Defaults to official Cursor API |

In the reference deployment, `DB_*` values are injected by `integrations.db`;
do not duplicate them as manual secrets. Other deployments should store
`DATABASE_URL` and `MIGRATION_DATABASE_URL` in their platform secret manager.

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

Download a fresh installer after verifying `CURSOR_MONITOR_HOOK_TOKEN`.
Previously generated scripts retain the old credential.

### Hooks never reach the app

Verify `VERCEL_PROTECTION_BYPASS`, installer endpoint, and local hook log. A
preview installer posts to preview and therefore writes to the preview database.

### Cron returns 401

Verify `CRON_SECRET` is present in the deployment. Vercel sends it as a Bearer
token.

### Team sync returns 401/403

Verify the credential mode and endpoint. Organization credentials require both
key and organization ID. Team credentials may not have access to filtered usage
on every plan.

### Sync always skips as running

The lock expires after ten minutes. If no run is active and the row remains,
inspect `monitor_sync_locks` in PostgreSQL and compare its `expires_at` value.
Normal syncs delete the lease in `finally`.

### Costs appear pending

Check the unmatched usage count and sync history. Hook and Team API conversation
IDs must normalize to the same value. Inspect raw payloads in the project event
details and `monitor_team_usage_events`.

## Rotation order

For zero-downtime hook token rotation:

1. update the encrypted secret and deploy;
2. download fresh installers;
3. update committed/team-managed hook scripts in monitored repositories.

Old hooks begin returning 401 after step 1. If uninterrupted ingestion is
mandatory, add dual-token support in a reviewed change before rotation.

## Retention

The initial schema does not delete raw events. Add retention only with an
explicit decision record and separate raw versus aggregate requirements.
