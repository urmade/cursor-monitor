# Open questions

Questions that need a human answer, ordered by how early they block work. Each states who can answer it, what happens if the answer is late, and the default the plans proceed with in the meantime.

`VISION.md` §17 listed seven open decisions. Five of them are now proposed decisions in [`decisions.md`](./decisions.md) (D5, D8, D9, D11/D3-adjacent, D12); the ones that genuinely need a person are below, alongside new questions the platform constraints raised.

---

## Blocking Phase 0

### Q1 — Do we have a Cursor service account and an appropriate plan tier?

**Status (2026-07-26).** Service-account key `cloud-agent` works for Cloud Agents API (`GET /v1/me`, create agents, usage with `chargedCents`). Team Admin API key currently `401 Invalid Team API Key`. See `docs/decisions/ADR-0007-cost-data-availability.md` — Admin API is no longer required for per-run charges on the cloud-agent path.

**Needs (remaining).** Valid team Admin key only if we want `filtered-usage-events` reconciliation beyond `/v1/agents/{id}/usage`.

**Who.** Cursor team admin (Admin key only).

### Q2 — Can cloud agents reach our MCP endpoint?

**Status (2026-07-26, resolved).** Protection Bypass secret works. Current cloud-agent environment has `egressMode: allow_all`; `*.internalsphere.com` is reachable. Live Spike A: injected MCP + bypass + run bearer → `spike_get_ticket` / `spike_post_report` succeeded (`docs/decisions/evidence/04-spike-a-live.md`, ADR-0004). Without bypass, Passport still returns 302. Earlier TLS-reset findings applied only to the prior restricted environment (historical note in `02-egress-blocker.md`).

**Needs.** None for Phase 0.

**Who.** n/a (closed).

### Q3 — Which repositories may the PoC's agents run against?

**Status (2026-07-26).** `internalsphere/nexus` accepts cloud agents. `urmade/nexus-test-*` return `400 repository_access` (Cursor GitHub App not installed). No-repo agents work for MCP-only spikes.

**Default in use.** No-repo agents, or `internalsphere/nexus` with `autoCreatePR: false`.

**Who.** Project owner if dedicated sandboxes remain desired.

---

## Blocking Phase 2

### Q4 — Who authors the companion automations, and when?

`Implementation Phases.md` calls this "the most commonly underestimated dependency in the plan", and it is external to this codebase: scoping, plan, and implementation automations that read the ticket via MCP and post a stage report. Phase 2's demo is impossible without at least the scoping one.

**Status (2026-07-26).** Phase 0 Spike B blocked: no hand-authored Nexus webhook automation exists (`docs/decisions/evidence/06-spike-b-blocker.md`). Primary path remains Cloud Agents API.

**If late.** Phase 2 can be built against a stub agent (a prompt we control that exercises the same MCP tools), but the phase does not close until a real automation does it.

**Default.** The implementing team hand-authors a minimal scoping automation as part of Phase 2 step 2.9, and treats richer ones as owned elsewhere.

**Who.** Project owner to nominate.

### Q5 — Is the "prompt template per binding" acceptable, or must we go webhook-only?

D5 explains the tension: the direct Cloud Agents API path requires us to store a small dispatch prompt per binding, which sits close to the "we do not author automations" line in `VISION.md` §6.2. The webhook adapter avoids it entirely and loses run correlation, per-run credentials, and cancel.

**Default.** Direct API path with a deliberately minimal stub prompt; both adapters implemented.

**Who.** Product owner.

---

## Blocking Phase 1 (soft) — platform mechanics

### Q6 — What does the managed `ci-required` workflow actually run?

**Status (2026-07-26).** On PR #7, `ci-required` completes successfully alongside `resolve-app-manifest` and `secrets-policy`. It does **not** appear to run full `pnpm test`/`build` as a hard local-equivalent gate from this agent's perspective — treat unit tests as required locally/in-package until we confirm orchestrator script discovery. Deploy path runs migrations (`db:exec-migrations`) and Vercel build.

**Who.** `#proj-internalsphere` for definitive script list.

### Q7 — Is a Vercel cron schedule of one minute available on this project?

**Status (2026-07-26).** Cron route `/api/cron/tick` is deployed and works when invoked with `CRON_SECRET` (Spike A poller driven this way during demos). Automatic minute cadence on the Vercel project was not separately audited; treat as available via `vercel.json` crons and confirm in project settings if Phase 1 needs guaranteed ≤1m ticks.

**Who.** Empirically OK for Phase 0; platform UI check optional.

---

## Blocking Phase 4

### Q8 — What price table do we use, and who owns it?

Estimates need per-model input/output/cache-read/cache-write prices. Reconciled `chargedCents` from the Admin API includes the Cursor Token Rate, which our estimate will not model unless we add it.

**Default.** Seed the table from Cursor's published model pricing at kickoff, version it with `effective_from`, and show estimates with a visible "estimate" badge until reconciliation lands.

**Who.** Project owner, with finance input if internal chargeback matters.

### Q9 — What are the actual budget numbers?

`VISION.md` §15 leaves Low/Medium/High soft and hard thresholds and the project burn cap as configuration. The PoC needs plausible defaults so the demo means something.

**Default.** Low $5 / $10, Medium $25 / $50, High $100 / $200, project burn cap $1,000 — placeholders chosen to be crossable in a demo, not to be right.

**Who.** Project owner.

---

## Blocking Phase 7

### Q10 — Are we permitted a third-party model provider key?

D8 puts agentic gate evaluation in our backend, which needs a model API key in `secrets/`. Internal policy may prefer everything stay inside Cursor.

**If refused.** Use a no-repo Cursor cloud agent as the evaluator: slower, billed as a run, and it makes gate latency user-visible.

**Default.** Request the key; build behind the `GateEvaluator` port so either works.

**Who.** Project owner plus security.

---

## Blocking Phase 9

### Q11 — How much history before we show a cost range? (`VISION.md` §17.5)

**Default.** Show a range only with at least 5 comparable completed items (same project, same complexity, allowing label-based widening to 3 if the project is small); below that, show the complexity default and say why. Revisit once real data exists.

**Who.** Project owner; the plan can proceed on the default.

### Q12 — Who can raise a budget cap or override a gate?

The role matrix in `architecture-baseline.md` §6.3 is a proposal (`VISION.md` §17.7). The consequential question is whether raising a project burn cap requires a second person.

**Default.** `owner` and `maintainer` may raise caps and override gates; every override is recorded as an `Intervention` and appears in the audit view. No four-eyes requirement in the PoC.

**Who.** Project owner.

---

## Non-blocking, worth an early opinion

### Q13 — Policy Studio or board-embedded policy configuration? (`VISION.md` §17.1)

**Status (2026-07-27).** Closed — Policy Studio. See `docs/decisions/ADR-0009-policy-surface.md` (ADR-0008 was already used for the design system).

**Default used.** Prototype both against the stated criteria; ship Studio; delete board-embedded drawer.

### Q14 — Do we mirror any Bugbot / Cursor Review state? (`VISION.md` §17.6)

**Default.** No. Review stays in Cursor; the project expresses review outcomes through labels and human gates. Revisit only if a Phase 6 demo feels hollow without it.

### Q15 — What notification channels matter for the inbox?

**Default.** In-app plus a Slack incoming webhook per project. Email and digests are Phase 9 polish at best.
