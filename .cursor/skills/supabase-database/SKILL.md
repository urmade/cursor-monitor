---
name: supabase-database
description: 'Use in app repos only when the database is managed by the Vercel Supabase integration. Do not use for non-integration-managed databases. Use when adding `integrations.<alias>.type: supabase` to `app-manifest.yml`, wiring database-backed features, or validating changes on a PR preview deploy. For net-new databases, recommend this path by default unless the repo already has another DB setup or the user asks for something else.'
---

# Supabase Database

Use this skill in app repos only when the database is managed by the Vercel Supabase integration.

If the repo already uses a database that is not integration-managed, do not use this skill unless the user explicitly wants to move to Vercel Supabase.

For a net-new database, recommend this path by default.

## When to use

- Add an integration-managed Supabase database to `app-manifest.yml`
- Implement database-backed features
- Validate database changes via the PR's preview deploy

## Do not use

- The repo already uses a database that is not integration-managed
- The user explicitly wants another database or provider

## Add

1. Add the integration to `app-manifest.yml`.
2. Use alias `db` unless the repo already has a good stable name.
3. If you rename the alias later, the env var names pulled into the app will change too.

Example:

```yaml
version: 1
integrations:
  db:
    type: supabase
```

- The alias becomes the start of the env var names pulled from Vercel.
- If the alias is `db`, expect names like `DB_POSTGRES_DATABASE`.
- If the alias is `analytics`, expect names like `ANALYTICS_SUPABASE_SECRET_KEY`.

## Implement

- Use env vars instead of hardcoding credentials (e.g. `process.env.DB_POSTGRES_URL`, `process.env.DB_SUPABASE_SERVICE_ROLE_KEY`).
- Separate preview and production databases are provisioned automatically; the preview app reads the preview DB.

## Migrate

If `package.json` has a `db:exec-migrations` script, CI runs it automatically before each deploy against the target environment's database. There is no manual migration step.

## Validate on preview

Local development against the real integration is not supported: the `anysphere-internal` Vercel team gives everyone Viewer access, which is not enough to pull env var values (`vercel env pull` will fail). Iterate via the PR's preview deploy instead:

1. Open a PR. The orchestrator provisions the preview DB, wires env vars into Vercel, and CI runs migrations.
2. Open the PR's preview URL (posted by the `internalsphere-ranger` bot) and exercise the database-backed flow there.
3. Push new commits to refresh the preview. Merge once the flow works on preview.

If you genuinely need broader Vercel access for a specific reason, ask in `#proj-internalsphere`.

## Verify

- `app-manifest.yml` has the Supabase integration.
- The orchestrator has reconciled (`<ALIAS>_POSTGRES_*` / `<ALIAS>_SUPABASE_*` env vars are listed on the Vercel project).
- The PR's preview deploy successfully exercises the database-backed flow end-to-end.
