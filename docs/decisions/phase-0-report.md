# Phase 0 report — Nexus walking skeleton

**Date.** 2026-07-26  
**Branch / PR.** `cursor/phase-0-skeleton-36eb` / [#7](https://github.com/internalsphere/Nexus/pull/7)

## What we proved

1. **Platform host shape.** pnpm + Next under `apps/web` + Supabase + cron deploys on Internalsphere preview. `vercel.root_directory: apps/web` (merged on `main` via #8) is reconciled; the Next app must live under `apps/web`.
2. **Start agentic work.** Cloud Agents API with service-account key, client-supplied `agentId`, no-repo agents, injected `mcpServers`. Replay → `409 agent_id_conflict`; busy → `409 agent_busy`.
3. **Observe.** Cron-invoked poller + `GET /v1/agents/{id}/runs/{runId}` + usage at terminal (`chargedCents`, tokens). Cancel returns provider 500 — do not trust it.
4. **Agent reaches us.** Passport-protected preview + `x-vercel-protection-bypass` + per-run bearer. Live agent called `spike_get_ticket` / `spike_post_report` (`evidence/04-spike-a-live.md`).
5. **Failure case.** Agent terminal without MCP write → `completed_without_report` (`evidence/05-completed-without-report.md`).
6. **Cost.** `/v1/agents/{id}/usage` returns `chargedCents`; Admin API key invalid — not required for Phase 4 estimates vs provider charge on this path.

## What surprised us

- Root Directory reconciliation to `apps/web` lagged briefly (interim root-layout deploy); once applied, missing `apps/web` fails Vercel deploy.
- Earlier cloud-agent VM egress blocked `*.internalsphere.com` (TLS RST); a later environment with `egressMode: allow_all` unblocked the live loop. Passport bypass was never the TLS issue.
- Cursor `model` field must be `{ id: "..." }`, not a string.
- No Nexus webhook automation exists yet — Spike B blocked on Q4.

## Decisions (ADR pointers)

| ADR | Outcome |
|---|---|
| 0001 stack | Next under `apps/web` (`root_directory: apps/web`) |
| 0002 invocation | Cloud Agents API primary; webhook deferred |
| 0003 observation | Poll + cron; SSE opportunistic |
| 0004 MCP auth | Injected headers + run token — **live proven** |
| 0005 failures | Matrix; demo = no MCP → `completed_without_report` |
| 0006 identity | Passport + machine tokens |
| 0007 cost | Prefer agent usage endpoint |

## Teardown

Spike tables dropped via `0002_drop_spike.sql`. Spike routes, tools, demo scripts, and `P0_SPIKE` / `SPIKE_*` secrets removed. Kept: deploy skeleton, `packages/db` + `cursor-client` + `jobs` scaffolding, identity module, MCP route stub.

## What Phase 1–2 must design around

- Treat “provider finished without stage report” as a first-class run outcome.
- Keep per-run MCP injection + bypass for Passport hosts.
- Do not depend on cancel for recovery; use deadlines + poll.
- Automations (Q4) still required before the webhook adapter can be the default for any binding.
- Keep Next under `apps/web`; Root Directory reconciliation is proven.

These deltas are now written into the planning docs (annotated as **Phase 0 observations**):

- `Implementation plan/phases/architecture-baseline.md`
- `Implementation plan/phases/phase-01-system-of-record.md`
- `Implementation plan/phases/phase-02-agent-loop.md`
- `Implementation plan/phases/phase-04-economics.md` (usage-endpoint costs vs Admin API)
