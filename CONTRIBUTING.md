# Contributing to Nexus

Internalsphere-managed `nexus` app. Phase 0 de-risked the platform loop; product schema starts in Phase 1.

## Prerequisites

- Node 22+ (see `.nvmrc`)
- pnpm 10 (`packageManager` in root `package.json`)
- Docker (optional, for local Redis only)
- `sops` ≥ 3.10 for secrets CLI encryption

## Local setup

```bash
pnpm install
docker compose up -d          # redis:7 (optional)
cp .env.example .env.local
# edit .env.local with local values (never commit it)
# Database: use the existing Supabase integration only — set DB_POSTGRES_URL
# from the preview/production Supabase instance. Do not stand up local Postgres.

pnpm db:exec-migrations       # applies packages/db/migrations/*.sql against Supabase
pnpm dev                      # Next.js at http://localhost:3000
```

Useful checks:

```bash
pnpm typecheck
pnpm --filter @nexus/cursor-client test
python3 scripts/app-manifest.py
```

## Why `vercel dev` / `vercel env pull` are unavailable

Everyone on the `anysphere-internal` Vercel team has **Viewer** access. Viewer cannot pull env vars or run a local Vercel runtime. Deploys and env sync happen only through the managed GitHub Actions workflow on PR previews and `main`.

Locally: Redis may run via Docker; the **only** database is the existing Supabase integration (`integrations.db` in `app-manifest.yml`). Prefer validating DB-backed flows on the PR preview URL. Anything that needs Passport, the protection bypass, or real Cursor credentials is validated there too.

## Secrets

Never commit plaintext `.env*` files (git hooks block them). Add credentials via SOPS:

```bash
python3 scripts/secrets.py add --scope shared --key CURSOR_API_KEY
python3 scripts/secrets.py list --scope local
```

See the `secrets-operations` Cursor skill for scope semantics (`shared` / `preview` / `production`).

## Monorepo layout

| Path | Role |
|---|---|
| `apps/web` | Only deployable (Next.js App Router); `vercel.root_directory: apps/web` |
| `packages/contracts` | Zod schemas |
| `packages/db` | Drizzle + migrations |
| `packages/core` | Domain services |
| `packages/cursor-client` | Typed `api.cursor.com` client |
| `packages/mcp` | MCP tool definitions (stub until Phase 2) |
| `packages/jobs` | Cron / job handlers |
| `packages/config` | Shared TypeScript base config |

`app-manifest.yml` declares the Supabase `db` integration and `vercel.root_directory: apps/web`. See ADR-0001.

## Policy-managed files

Do not edit managed workflows, `CODEOWNERS`, `.sops.yaml`, hooks, orchestrator scripts, distributed skills, `secrets/inventory.yaml`, or `QUICKSTART.md` — they are overwritten on reconciliation. Never bypass git hooks with `--no-verify`.
