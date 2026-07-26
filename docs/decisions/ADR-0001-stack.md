# ADR-0001 — Stack versions (Phase 0 kickoff)

## Status

Accepted — PR preview deploys with Next under `apps/web` (`vercel.root_directory: apps/web`).

## Decision

Pin the Phase 0 toolchain to:

| Package | Version |
|---|---|
| Node | 22 (`.nvmrc`) |
| pnpm | 10.33.3 (`packageManager`) |
| Next.js | 16.2.12 |
| React | 19.2.8 |
| TypeScript | 5.8.x |
| Drizzle ORM | 0.44.x |
| postgres.js | 3.4.x |
| Zod | 3.25.x |
| Vitest | 3.2.x |
| Turbo | 2.5.x |

## Why

Current at kickoff (2026-07-26); Next 15.4.6 was rejected due to CVE-2025-66478 advisory during scaffold.

## Consequences

- Next.js App Router lives under **`apps/web`** with `vercel.root_directory: apps/web` in `app-manifest.yml` (reconciled on the Vercel project after PR #8). An interim root-layout deploy worked before reconciliation applied; once Root Directory pointed at `apps/web`, the app must live there or deploy fails with a missing-path error.
- Local/dev uses `pnpm --filter @nexus/web dev` (`next dev --turbopack`).
- Workspace packages are TypeScript source consumed via `transpilePackages` (Bundler moduleResolution, extensionless imports).
