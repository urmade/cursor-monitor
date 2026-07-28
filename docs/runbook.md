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

## Phase 3 — process enforcement

| Surface | URL | Notes |
|---|---|---|
| Policy Studio | `/projects/[key]/policies` | Gates, bindings list, pending approvals, budgets placeholder (ADR-0009) |
| Ticket Checks | `/projects/[key]/items/[itemKey]` | Latest gate results, warnings, approvals, dry-run |
| Board chips | `/projects/[key]/board` | `blocked_by_gate` / `needs_approval` with reason text |

### Feature flags & modes

- `p3.gates` (per project / env `FLAG_P3_GATES=1`) — until enabled, transitions behave as Phase 1/2.
- Project `settings.enforcement_mode`: `enforce` (default) or `observe` (evaluate & record, never block).
- New gates are **created disabled**; enabling is a second deliberate action.

### A ticket is stuck and nobody knows why

1. Open the ticket → **Checks** panel. Every applicable gate's latest outcome, reason, and evidence is listed (all gates evaluate even after one blocks).
2. Use **Why can't I move this?** dry-run against the target stage — it lists every failing gate at once without mutating state.
3. If status is `needs_approval`, approve/reject from Checks (or Policies → Approvals). Approval re-runs the batch and completes the original transition when nothing else blocks.
4. If status is `blocked_by_gate`, fix the cited fact (complexity, label, open warning, etc.) or have an `owner`/`maintainer` override with a mandatory reason (recorded as an `intervention`).
5. Confirm project `enforcement_mode` is not unexpectedly `enforce` during a rollout, and that `p3.gates` is intentional.
6. Audit → filter `gate.blocked` / `gate.evaluated` / `intervention.recorded`. Stored evaluations keep `gate_version` + `gate_config` — later gate edits do not rewrite history.
7. Pathological config: max 40 gates/project; condition depth ≤ 8; contradicting `on_failure` on the same trigger is warned at create time.
8. Snapshot retention: keep `context_snapshot` 90 days at full fidelity; older rows may be trimmed to `evidence` only (ops job TBD — index `gate_evals_created` supports the sweep).

### Overrides

Only `owner`/`maintainer` (`gate.override`). Reason required. Visible forever on the transition (`reasonCode: gate_override`) and in `interventions`.

## Phase 4 — economics

| Surface | URL | Notes |
|---|---|---|
| Ticket spend | `/projects/[key]/items/[itemKey]` | Budget bar, per-run cost with source badge |
| Spend audit | `/projects/[key]/spend` | `budget_events` timeline |
| Project settings | `/projects/[key]/settings` | Burn cap & complexity defaults (`settings.budget`) |

### Feature flags

- `p4.budgets` — when off, estimation/rollups still run; enforcement (pre-launch block + budget gate blocks) is skipped.

### Costs look wrong

1. Check each run's `cost_source` on the ticket timeline (`Provider` vs `Estimate` badge).
2. Compare `cost_estimate_micro_usd` vs `cost_micro_usd` on the run row (provider drift).
3. Run or wait for `recompute_cost_rollups` — non-zero drift is written to `cost_rollup_checks` and emitted as `cost.rollup_drift` (not auto-repaired).
4. Admin reconciliation requires a valid team Admin key; on our tier it 401s (ADR-0007) — rely on usage-endpoint `chargedCents`.
5. Unknown models produce `price.model_unknown` warnings and zero estimates until `model_prices` is updated.

### Running DB-backed tests locally

Cloud agent VMs do **not** have Docker. Use apt Postgres (installs in ~10s):

```bash
sudo apt-get update -qq && sudo apt-get install -y -q postgresql
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres psql -c "CREATE DATABASE nexus_test;"
export DB_POSTGRES_URL="postgres://postgres:postgres@127.0.0.1:5432/nexus_test"
export DB_SSL=disable
pnpm db:exec-migrations
pnpm test
```

Integration suites (`integration.services.test.ts`, `gates.integration.test.ts`, `cost.integration.test.ts`, `cost.rollups.property.test.ts`) require `DB_POSTGRES_URL`; without it they are skipped.
