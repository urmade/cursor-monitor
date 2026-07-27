# Nexus runbook

## Phase 1 surfaces

| Surface | URL | Notes |
|---|---|---|
| Projects list / create | `/projects` | Templates: default, minimal, empty |
| Board | `/projects/[key]/board` | Columns from project stages; quick-create; manual move |
| Ticket detail | `/projects/[key]/items/[itemKey]` | Spec versions, timeline, activity |
| Settings | `/projects/[key]/settings` | Pipeline rename/add, label taxonomy |
| Audit | `/projects/[key]/audit` | Filtered read of `events` outbox |
| Health | `/api/health` | DB, migration version, cron tick, queue depth |
| Cron | `/api/cron/tick` | Requires `CRON_SECRET`; claims `jobs` |

### Local demo

```bash
# Postgres (docker compose or local)
export DB_POSTGRES_URL=postgres://nexus:nexus@localhost:5432/nexus
export DB_POSTGRES_URL_NON_POOLING=$DB_POSTGRES_URL
export DB_SSL=disable

pnpm db:exec-migrations
pnpm db:seed -- --demo
pnpm dev
```

Open `/projects` — Alpha (default pipeline + risk/touches labels) and Beta (minimal + Design stage + product labels) should exist.

### Identity

- Preview/production: Passport JWT via `x-vercel-oidc-passport-token` (`external_sub`).
- Local: `local-dev-user` fallback when `VERCEL` is unset.
- Users are upserted into `users` on first request; project creators become `owner`.

### Feature flags

`p1.projects`, `p1.workitems`, `p1.specs` are seeded enabled. Phase 1 UI does not hard-gate on them; they remain for emergency kill via env `FLAG_P1_*`.
