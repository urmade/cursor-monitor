# Operations

## Deployment

Preview and production deploy only through the managed GitHub workflow. Pushing
a PR provisions the preview Supabase integration, applies migrations, and
deploys `apps/web`.

Do not run `vercel deploy`, `vercel env pull`, or a local database.

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
| `CURSOR_MONITOR_HOOK_TOKEN` | Recommended | Dedicated inbound app token |
| `VERCEL_PROTECTION_BYPASS` | Yes for protected deployments | Also fallback app token |
| `CRON_SECRET` | Yes | Vercel cron authorization |
| `CURSOR_TEAM_API_KEY` | One credential mode | Team filtered usage |
| `CURSOR_ORGANIZATION_API_KEY` | One credential mode | Pair with organization ID |
| `CURSOR_ORGANIZATION_ID` | Organization mode | Required with organization key |
| `CURSOR_API_BASE_URL` | No | Defaults to official Cursor API |

Supabase `DB_*` values are injected by `integrations.db`; do not add them as
manual secrets.

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
inspect `monitor_sync_locks` in the managed Supabase project and compare its
`expires_at` value. Normal syncs delete the lease in `finally`.

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
