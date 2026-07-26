# Open questions

Questions that need a human answer, ordered by how early they block work. Each states who can answer it, what happens if the answer is late, and the default the plans proceed with in the meantime.

`VISION.md` §17 listed seven open decisions. Five of them are now proposed decisions in [`decisions.md`](./decisions.md) (D5, D8, D9, D11/D3-adjacent, D12); the ones that genuinely need a person are below, alongside new questions the platform constraints raised.

---

## Blocking Phase 0

### Q1 — Do we have a Cursor service account and an appropriate plan tier?

**Needs.** A team or enterprise service-account API key for the Cloud Agents API, plus a team-scoped Admin API key for usage reconciliation. `filtered-usage-events` — the only source of reconciled `chargedCents` — is documented as Enterprise.

**If late.** Phase 0 cannot start at all. Phase 4 ships estimate-only costs, which is survivable but must be labelled in the UI.

**Default.** Proceed with a personal API key for the Phase 0 spike only, and treat the service account as a Phase 2 blocker.

**Who.** Cursor team admin.

### Q2 — Can we get a Protection Bypass for Automation on the `nexus` Vercel project?

**Needs.** A request in `#proj-internalsphere` explaining that Cursor cloud agents must reach `/api/mcp` on both preview and production deployments, which Passport otherwise blocks. The internalsphere skill documents this as the sanctioned path for webhook integrations.

**If late.** The entire orchestration model is unprovable. There is no workaround inside this platform — a second, unprotected host would be a new Vercel project outside the orchestrator's model.

**Default.** None. This is a hard dependency and should be requested on day one.

**Who.** `#proj-internalsphere`.

### Q3 — Which repositories may the PoC's agents run against?

**Needs.** At least one real repository that the Cursor org can start cloud agents in, with permission to open branches and PRs. Ideally a sandbox repository rather than a production service.

**If late.** Phase 0 spikes can use a scratch repository, but Phase 2's demo needs something a stakeholder recognises.

**Default.** A dedicated `nexus-poc-sandbox` repository.

**Who.** Project owner.

---

## Blocking Phase 2

### Q4 — Who authors the companion automations, and when?

`Implementation Phases.md` calls this "the most commonly underestimated dependency in the plan", and it is external to this codebase: scoping, plan, and implementation automations that read the ticket via MCP and post a stage report. Phase 2's demo is impossible without at least the scoping one.

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

We cannot read `internalsphere/internal-app-orchestrator` from here, so it is unknown whether `ci-required` runs `pnpm lint` / `test` / `build` for a monorepo, and whether an app-owned workflow file may be added alongside the managed one without being reconciled away.

**If unanswered.** Tests exist but may not gate merges — an unacceptable state for a system that enforces process.

**Default.** Define standard `lint`, `typecheck`, `test`, `build` scripts at the workspace root, observe what CI does on the Phase 0 deploy PR, and ask in `#proj-internalsphere` if the scripts are not picked up.

**Who.** `#proj-internalsphere`; verified empirically in Phase 0.

### Q7 — Is a Vercel cron schedule of one minute available on this project?

The scheduler assumes minute-granularity cron. Team plan tier and any orchestrator-level constraints on `vercel.json` need confirming.

**If unavailable.** Fall back to a self-triggering job chain (a handler that re-invokes the tick endpoint) or accept coarser polling with slower UI feedback.

**Default.** Minute cron; verified in Phase 0 step 0.1.

**Who.** Verified empirically; `#proj-internalsphere` if it fails.

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

Phase 3 forces this decision with a timeboxed prototype of both (step 3.7). An early steer from the product owner would save that timebox.

**Default.** Prototype both, decide on evidence, and keep the engine indifferent either way.

### Q14 — Do we mirror any Bugbot / Cursor Review state? (`VISION.md` §17.6)

**Default.** No. Review stays in Cursor; the project expresses review outcomes through labels and human gates. Revisit only if a Phase 6 demo feels hollow without it.

### Q15 — What notification channels matter for the inbox?

**Default.** In-app plus a Slack incoming webhook per project. Email and digests are Phase 9 polish at best.
