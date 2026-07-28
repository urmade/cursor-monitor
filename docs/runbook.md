# Nexus runbook

## Phase 1 surfaces

| Surface | URL | Notes |
|---|---|---|
| Projects list / create | `/projects` | Templates: default, minimal, empty |
| Board | `/projects/[key]/board` | Columns from project stages; quick-create; manual move; AI-working elapsed |
| Ticket detail | `/projects/[key]/items/[itemKey]` | Spec, runs/reports, questions, timeline, activity |
| Questions | `/projects/[key]/questions` | Open questions stopgap (Phase 6 inbox later) |
| Settings | `/projects/[key]/settings` | Pipeline, labels, automation bindings |
| Audit | `/projects/[key]/audit` | Filtered read of `events` outbox |
| Health | `/api/health` | DB, migration, cron, queue, MCP calls/min |
| MCP | `/api/mcp` | nexus-mcp/1 tools; Bearer run token |
| Cron | `/api/cron/tick` | Requires `CRON_SECRET`; claims `jobs` (`poll_run`, `sweep_stuck_runs`) |

### Local demo

```bash
export DB_POSTGRES_URL=postgres://nexus:nexus@localhost:5432/nexus
export DB_POSTGRES_URL_NON_POOLING=$DB_POSTGRES_URL
export DB_SSL=disable
export CURSOR_API_KEY=…          # or CURSOR_SERVICE_ACCOUNT_KEY
export DEPLOYMENT_URL=http://localhost:3000
export VERCEL_PROTECTION_BYPASS=… # when hitting Passport-protected preview from agents

pnpm db:exec-migrations
pnpm db:seed -- --demo
pnpm dev
```

### Identity

- Preview/production: Passport JWT via `x-vercel-oidc-passport-token` (`external_sub`).
- Local: `local-dev-user` fallback when `VERCEL` is unset.
- Users are upserted into `users` on first request; project creators become `owner`.

### Feature flags

Phase 1: `p1.projects`, `p1.workitems`, `p1.specs`.
Phase 2: `p2.mcp`, `p2.bindings`, `p2.runs`, `orchestration.enabled` (global kill switch).
Override via env `FLAG_P2_RUNS=0` etc.

## Phase 2 — agent loop ops

### A run is stuck

1. Check `/api/health` → queue depth and `lastCronTick`.
2. Ticket → run row: status `launched`/`running`, `deadline_at`, `error_detail`.
3. Cron `sweep_stuck_runs` force-expires past-deadline runs — **do not** rely on provider cancel (may 500 while still RUNNING).
4. UI Cancel is best-effort; if cancel fails, the run keeps polling until terminal or deadline.

### An agent cannot reach MCP

1. Confirm preview bypass: agent launch injects `x-vercel-protection-bypass`.
2. Confirm Bearer run token not expired/revoked (`mcp_tokens`).
3. `GET /api/mcp` without auth should still return tool list metadata; `tools/call` needs Bearer.
4. Check `mcp_call_log` and `/api/health` → `mcp.callsLastMinute`.

### Reports are rejected

1. Unknown or non-`agent_settable` labels reject the **whole** report — fix taxonomy or omit the label.
2. Second `post_stage_report` for the same run returns `already_posted: true` (idempotent).
3. Oversized payloads → `payload_too_large` / validation errors with limits from `docs/mcp-contract.md`.

### Spend controls (pre–Phase 4)

Per project settings JSON: `concurrentRunCeiling` (default 5), `dailyRunCap` (default 50).
Per binding: `maxDurationMinutes`. Global: `orchestration.enabled` flag.
