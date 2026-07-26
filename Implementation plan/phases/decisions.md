# Standing technical decisions

Decisions taken while writing these plans, so the phase documents can be read as instructions rather than as arguments. Each one states what was decided, why, what it costs to reverse, and which phase would have to change.

Decisions marked **provisional** are pending Phase 0 evidence or a human answer (see [`open-questions.md`](./open-questions.md)); they are written as the default we proceed with if nothing contradicts them. When a decision is confirmed or overturned during implementation, record it as an ADR in `docs/decisions/` and update the row here.

---

### D1 — One deployable, not a service split

**Decision.** UI, REST API, MCP server, and background workers all ship inside the single Next.js app in `apps/web`.

**Why.** The orchestrator gives this repo exactly one Vercel project (`nexus`). A second service would need its own repo, its own bootstrap, and its own secret plumbing, and would double the preview-deploy surface for a PoC whose whole value is in one coherent state machine. Package boundaries inside the monorepo give us the modularity without the operational cost.

**Reversal cost.** Low-to-moderate. Because `packages/core` has no Next.js dependency, extracting the MCP server or the workers later means adding a host, not rewriting logic.

---

### D2 — pnpm + Turborepo monorepo with `vercel.root_directory: apps/web`

**Decision.** Standard monorepo layout with the deployable under `apps/web`, declared to the orchestrator via `app-manifest.yml`.

**Why.** The user's stated intent is a Next.js monorepo, and `scripts/app-manifest.py` supports `vercel.root_directory` precisely for this. The alternative — Next.js at the repository root — makes the domain packages awkward and blocks a second app later.

**Risk.** Monorepo root-directory configuration is the single most common cause of "green deploy, 404 page" on this platform (`internalsphere-setup` skill). Phase 0 step 0.1 exists to prove the deploy before any product code is written.

**Reversal cost.** Low if caught in Phase 0, high afterwards.

---

### D3 — Postgres (Supabase) is the only system of record; Redis is disposable

**Decision.** All durable state, including the job queue and the event outbox, lives in Postgres. Upstash Redis holds locks, rate-limit counters, idempotency markers, and short-lived caches only.

**Why.** Transactional consistency between a state change and its event is the backbone of the audit story (`VISION.md` §F4). A separate queue technology would break that transaction boundary for no benefit at PoC volume — this system processes human-scale traffic and tens of agent runs per day, not thousands per second.

**Reversal cost.** Low. The `packages/jobs` queue interface hides the storage.

---

### D4 — Supabase is Postgres and nothing else

**Decision.** No Supabase Auth, no PostgREST access from the browser, no Realtime in the PoC. RLS is enabled with no policies and the `anon`/`authenticated` roles are revoked, as defence in depth.

**Why.** Passport already owns identity, and mixing two identity systems in a PoC is a security liability. Server-side-only data access keeps authorisation in one place (`packages/core/authz`) where it can be tested.

**Reversal cost.** Moderate for Realtime (would require rethinking browser credentials); low for the rest.

---

### D5 — Direct Cloud Agents API is the primary invocation path; automation webhooks are a supported adapter — **provisional, Phase 0 decides** (`VISION.md` §17.2)

**Decision.** `packages/core/runs` depends on an `AgentInvoker` port with two adapters:

- **`cloud-agent`** (default): `POST /v1/agents` with a client-supplied `agentId` for idempotency, our MCP server injected through `mcpServers[]` with a per-run bearer token, and observation via `GET /v1/agents/{id}/runs/{runId}`.
- **`automation-webhook`**: `POST` to the automation's private webhook URL with `Authorization: Bearer <key>` and a body containing the ticket id and a run nonce.

**Why the default.** The direct path gives us four things the webhook path cannot: a run id at launch (correlation without guesswork), per-run scoped MCP credentials instead of one long-lived shared token, first-class cancel, and per-run token usage from `GET /v1/agents/{id}/usage`. The webhook path's payload is appended to the agent's instructions, which is enough to pass a ticket id but leaves us correlating by nonce and reconciling usage after the fact.

**Nuance.** `VISION.md` is emphatic that this system does not author automations. The `cloud-agent` adapter does mean we store a prompt template per binding, which is *close to* authoring. The distinction we hold: our template is a thin dispatch stub (identify the ticket, tell the agent where the MCP server is, require a stage report); all substantive instructions live in the repo's rules or in the automation. If that line feels wrong to stakeholders, the `automation-webhook` adapter is the answer and it exists for exactly that reason.

**Reversal cost.** Low — the port is chosen per binding, so both can coexist in the same project.

---

### D6 — MCP configuration is injected per run, not committed to the target repository

**Decision.** The run launcher passes `mcpServers: [{ name: 'nexus', type: 'http', url: <deployment>/api/mcp, headers: { Authorization: 'Bearer <run token>', 'x-vercel-protection-bypass': <secret> } }]` on every agent create or follow-up run.

**Why.** It removes a static, long-lived, broadly-scoped token from every participating repository, and it makes revocation trivial: the token dies with the run. It also means a repository needs no Nexus-specific configuration to participate.

**Consequence.** Under the `automation-webhook` adapter this is not possible — automations own their MCP config — so that adapter uses a project-scoped token plus a per-run nonce, and accepts the weaker scoping.

**Reversal cost.** Low.

---

### D7 — Poll first, stream opportunistically, never depend on webhooks

**Decision.** Run observation is a cron-driven poller with adaptive intervals (5 s for the first minute, then 15 s, then 60 s, capped by a per-run deadline). The SSE stream is used only to make the UI feel live, and any stream failure — including `410 stream_expired` — falls back to polling.

**Why.** v1 webhooks are documented as "coming soon", SSE needs a long-lived connection that Vercel functions do not provide, and `Implementation Phases.md` flags Cursor's event surface as the top architectural risk. Polling is boring and cannot regress.

**Reversal cost.** Low. Adding a webhook receiver later is additive; the poller stays as the reconciler.

---

### D8 — Agentic gates run in our backend against a model provider API — **provisional** (`VISION.md` §17.3)

**Decision.** Phase 7 evaluates rubrics with a direct LLM call from our backend (Vercel AI SDK, structured output, temperature 0), behind a `GateEvaluator` port. When the verdict is Block and remediation is needed, the rewrite is performed by a bound Cursor Automation — never by a loop inside our product.

**Why.** A gate must answer in seconds inside a transition; a cloud agent takes tens of seconds to start and is billed as a run. The vision also explicitly prefers our backend for Pass/Warn/Block.

**Dependency.** Requires an approved model-provider key in `secrets/`. If that approval does not come, the fallback adapter is a no-repo Cursor cloud agent (the v1 API supports omitting `repos` and `env`), accepting the latency and cost.

**Reversal cost.** Low — one adapter behind a port.

---

### D9 — Warnings are durable until explicitly resolved, and carry the stage they came from (`VISION.md` §17.4)

**Decision.** A warning is a row with `status ∈ {open, dismissed, resolved}`, an `origin_stage_instance_id`, and the gate evaluation that produced it. They do not expire on stage exit. Gate conditions can ask for `warnings.open`, `warnings.open_in_current_stage`, or `warnings.count_by_code`.

**Why.** The vision wants Warn to be "first-class context" that later gates consume. Silent expiry on stage exit would make the most valuable case — a Plan-stage warning informing a Review-stage gate — impossible. Explicit dismissal keeps a human in control of the noise and produces the intervention data Phase 9 wants.

**Reversal cost.** Low; scoping is a query concern.

---

### D10 — Status is derived, with overrides recorded as facts

**Decision.** `work_items` stores no free-text status. A pure function `deriveStatus(item, facts)` computes the display state from stage, open blocking questions, pending approvals, active runs, budget state, failed runs, and loop escalations. A human override is a separate row (`status_overrides`) that the derivation reads and reports as an override.

**Why.** `VISION.md` §F1 and Phase 3's outcome both call for derived state. Storing a mutable status column invites drift the moment two sources disagree.

**Reversal cost.** High if introduced late — this is why the derivation function exists from Phase 1 even though it has almost nothing to derive from yet.

---

### D11 — Conditions are a small typed DSL, evaluated in-process

**Decision.** Gate and binding conditions are a zod-validated JSON AST over a fixed context (`labels`, `complexity`, `stage`, `cost`, `loop_count`, `warnings`, `report.*`, `project.*`) with `and`/`or`/`not`, comparison, `includes`, and `exists`. No expression strings, no `eval`, no third-party rules engine.

**Why.** The condition surface is small and known (`VISION.md` §6.3 enumerates it), it must be renderable as a form in the configuration UI, and it must be safely evaluable on user input. A JSON AST is both.

**Reversal cost.** Moderate — stored conditions would need migrating. Mitigated by versioning the AST (`{ v: 1, ... }`) from the first row.

---

### D12 — Cost is stored as integer micro-dollars with an explicit source

**Decision.** Every cost column is `bigint` micro-dollars alongside a `cost_source ∈ {estimated, reconciled}`. Estimates come from token counts × a versioned price table; reconciliation comes from the Admin API's `chargedCents` joined on `cloudAgentId`. The UI never shows a number without its source.

**Why.** Floats accumulate error across run → stage → item → project rollups, and the vision insists estimates be labelled honestly. Cursor reports fractional cents, so cents alone is not precise enough.

**Reversal cost.** High. Get this right in Phase 4 and it never needs revisiting.

---

### D13 — The event outbox exists from Phase 1

**Decision.** Every state-changing service writes an `events` row in the same transaction, even though nothing consumes events until Phase 6 and nothing publishes them until Phase 8.

**Why.** It is nearly free now and expensive later: retrofitting means revisiting every service and backfilling history that no longer exists. It also gives Phase 1 its audit trail for free.

**Reversal cost.** n/a — this is the cheap direction.

---

### D14 — Attention items are materialised, not computed on read

**Decision.** Phase 6 maintains an `attention_items` table from event handlers, with a reconciliation job that rebuilds from source state and reports drift.

**Why.** The inbox is the product's home page; it must be fast, filterable, and sortable across projects. A five-way UNION over questions, approvals, budget blocks, failed runs, and loop escalations gets slow and untestable. Materialising also makes "why is this here" a stored, explainable field rather than a re-derivation.

**Reversal cost.** Low — the reconciliation job means the table can always be rebuilt.

---

### D15 — Ranking is deterministic and explainable, never a model call

**Decision.** Inbox ranking is a documented scoring function over typed inputs (blocking kind, age, complexity, spend at risk, loop count). Every row can show the reason it ranks where it does.

**Why.** A human's trust in the inbox is the whole product thesis. An opaque ranking that occasionally hides something urgent destroys that trust faster than a mediocre but predictable one.

**Reversal cost.** Low.

---

### D16 — Trunk-based development behind feature flags

**Decision.** Every step in every phase is a PR to `main`, shipped dark behind a `feature_flags` row, with the flag removed in the phase's last step.

**Why.** `main` is production and the branch protection rules make long-lived branches painful. Flags also give the demo a rehearsal mechanism: enable for one project, walk the script, then enable broadly.

**Reversal cost.** n/a.

---

### D17 — Idempotency everywhere an agent or an external caller can retry

**Decision.** MCP write tools and REST writes accept an `Idempotency-Key`; the launcher derives a deterministic `agentId` per (work item, stage instance, binding, attempt) so a duplicate create returns `409 agent_id_conflict` instead of a second agent; job handlers are written to tolerate re-execution.

**Why.** Agents retry. Cron re-runs. Serverless functions get replayed. Every one of those is a chance to charge twice or double-post a stage report.

**Reversal cost.** High if retrofitted, trivial if designed in.

---

### D18 — Local development uses Docker Postgres and Redis, and the preview deploy is the integration environment

**Decision.** `docker compose` provides Postgres and Redis for local work; anything touching Supabase, Passport, or Cursor is validated on the PR preview URL.

**Why.** `vercel env pull` and `vercel dev` are unavailable on this platform by design. Pretending otherwise wastes a week discovering it.

**Consequence.** Local mode needs a documented fake-identity path (guarded so it cannot activate in a deployed environment) and a seed script that produces a demo-ready dataset.

**Reversal cost.** n/a.
