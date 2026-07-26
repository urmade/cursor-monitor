# Phase 4 — Economics

> **Outcome.** "Work has a price and a ceiling. Costs roll up from run to stage to work item to project. Complexity tiers carry default budgets that apply automatically. A project has a burn budget that blocks further work when crossed. Budget gates warn at a soft threshold and block at a hard one, and a human can raise a cap or pause work deliberately."
>
> **Proof.** A high-complexity ticket inherits its budget automatically, crosses its soft threshold and shows a warning, then crosses its hard threshold and is blocked mid-pipeline. A project burn cap blocks a second ticket that would otherwise have started. A human raises the cap and work resumes, with both the block and the override audited. Costs shown as estimates are visibly labelled as estimates.
>
> **Milestone.** M3 — Governed. **Depends on.** Phase 2 (run usage data), Phase 3 (the gate engine). **Unblocks.** Phase 9 estimation; safe unattended operation.

---

## 1. Objective and scope

Phase 4 is what makes it responsible to leave the system running. `Implementation Phases.md` puts it plainly: "No phase should encourage leaving work running unattended before Phase 4 is complete."

Two properties matter more than the feature list:

1. **Block before spending, not after.** A budget that is checked when a run finishes has already spent the money. The decisive check happens in the launcher, before the provider call, using committed spend plus a reservation for the run about to start.
2. **Never present an estimate as a fact.** Cursor's Admin API exposes reconciled `chargedCents`, but only hourly and only on a plan tier we must confirm (Phase 0 step 0.7). Until reconciliation arrives — and permanently, if the tier does not expose it — every figure carries its source (D12).

### In scope

Money primitives and the versioned price table; per-run cost estimation from token usage; rollups from run to stage instance to work item to project; reconciliation against the Admin API; complexity-derived budgets with per-item override; the project burn cap; the budget gate evaluator and the pre-launch check; cap raises, pauses, and their audit trail; cost surfaces across ticket, board, and project.

### Out of scope

| Not in Phase 4 | Lands in |
|---|---|
| Predictive cost ranges for new tickets | Phase 9 |
| Loop cost attribution | Phase 5 (this phase makes it possible) |
| Budget blocks in a ranked inbox | Phase 6 |
| Cost of agentic gate evaluations | Phase 7 adds them to the same rollup |
| Cross-project spend analytics and chargeback | Phase 9, thinly |

---

## 2. Preconditions

- Phase 0 step 0.7 answered: does our plan tier return `chargedCents` from `POST /teams/filtered-usage-events`, and does `cloudAgentId` join to our recorded agent id? If no, this phase ships estimate-only and says so in the UI.
- A team-scoped Admin API key in `secrets/` (Q1).
- Phase 2 records `tokens` and `usage_uuid` on every terminal run.
- Phase 3's gate engine with the `budget` evaluator registered as a stub.
- Q8 (price table ownership) and Q9 (actual budget numbers) answered, or the documented placeholders accepted for the demo.

---

## 3. Technical approach

### 3.1 Money

`bigint` micro-dollars everywhere (D12). One conversion module, no ad-hoc arithmetic:

```ts
// packages/core/src/cost/money.ts
export type MicroUsd = bigint;                     // 1 USD = 1_000_000n
export const fromCents = (c: number): MicroUsd => BigInt(Math.round(c * 10_000));
export const toDisplay = (m: MicroUsd, opts?) => …; // "$1.24", "$0.003", "<$0.01"
```

Every stored cost is accompanied by `cost_source ∈ { estimated, reconciled, mixed }`. `mixed` exists because a rollup can contain both, and pretending otherwise is how a dashboard starts lying.

### 3.2 Price table

```sql
create table model_prices (
  id uuid primary key,
  model text not null,                    -- as reported by the provider
  input_micro_usd_per_1k    bigint not null,
  output_micro_usd_per_1k   bigint not null,
  cache_write_micro_usd_per_1k bigint not null default 0,
  cache_read_micro_usd_per_1k  bigint not null default 0,
  surcharge_bps integer not null default 0,  -- e.g. the Cursor Token Rate, in basis points
  effective_from timestamptz not null,
  note text,
  unique (model, effective_from)
);
```

Lookup selects the row with the greatest `effective_from` at or before the run's start, so re-estimating an old run does not silently reprice history. An unknown model produces a cost of zero with `cost_source = 'estimated'` and a `price.model_unknown` warning attached to the run — visible, not swallowed. `surcharge_bps` exists because reconciled `chargedCents` includes the Cursor Token Rate for third-party models while a naive token estimate does not; without it, every estimate is systematically low.

### 3.3 Estimation and rollups

At run close-out (extending Phase 2's `closeOutRun`):

```
estimate = Σ over token buckets (tokens_k / 1000) × price_k, then × (1 + surcharge_bps/10_000)
```

Rollups are maintained incrementally in the same transaction that writes the run cost, and independently recomputed nightly:

| Level | Column | Maintained |
|---|---|---|
| Run | `runs.cost_micro_usd`, `cost_source` | At close-out |
| Stage instance | `stage_instances.cost_micro_usd` | Incremental on run close-out |
| Work item | `work_items.spend_micro_usd`, `spend_source` | Incremental |
| Project | `projects.spend_micro_usd` | Incremental |

The nightly `recompute_cost_rollups` job recalculates every level from `runs` and reports drift as an event rather than silently correcting it — silent self-healing hides the bug that caused the drift. Reconciliation deliberately changes these numbers, so the UI shows "updated from estimate to reconciled" rather than a value that mysteriously moved.

### 3.4 Reconciliation

An hourly job (`reconcile_costs`, respecting the documented once-per-hour polling guidance):

1. Find runs terminal in the last 72 hours whose `cost_source = 'estimated'`.
2. Query `POST /teams/filtered-usage-events` for the window with `cloudAgentId: '*'`, paging to completion.
3. Group events by `cloudAgentId` and match to `runs.provider_agent_id`.
4. **Allocate across runs.** Usage events attribute to the agent, and an agent can carry several runs (follow-ups, resumes). Where an agent maps to multiple runs, allocate `chargedCents` across them in proportion to each run's `totalTokens` from `GET /v1/agents/{id}/usage`, and mark the allocation method on the run. Exact per-run attribution is used when Phase 0 confirmed `usageUuid` matches an event field.
5. Write `cost_actual_micro_usd`, flip `cost_source` to `reconciled`, record the estimate alongside so drift can be measured, and re-run the rollups.
6. Emit `cost.reconciled` with the delta; a delta beyond a configurable threshold (default 30%) raises an internal warning so a wrong price row gets noticed.

Estimate-versus-actual drift is stored per run, which gives Phase 9 a free accuracy metric and lets us tune the price table with evidence.

### 3.5 Budgets

```ts
type ProjectBudgetSettings = {
  complexityDefaults: Record<'low'|'medium'|'high', { softMicroUsd: MicroUsd; hardMicroUsd: MicroUsd }>;
  burnCapMicroUsd: MicroUsd | null;
  burnSoftRatio: number;            // default 0.8
  blockOnBurnCap: boolean;          // default true
  reserveMicroUsdPerRun: MicroUsd;  // headroom assumed for a run about to start
};
```

Setting complexity on a work item applies the project default as `budget_micro_usd` **unless** the item has an explicit override (`budget_overridden = true`). Changing complexity later re-applies the new default only when there is no override, and the change is recorded either way.

### 3.6 Enforcement in two places

**Pre-launch (the one that saves money).** `launchRun` calls `checkBudget` before the provider call:

```ts
type BudgetDecision =
  | { allow: true; warn?: 'item_soft' | 'project_soft' }
  | { allow: false; reason: 'item_hard' | 'project_burn' | 'item_paused'; detail: … };
```

The check uses committed spend plus in-flight reservations (active runs each reserve `reserveMicroUsdPerRun`), so two simultaneous launches cannot both squeeze under the cap.

**Gate evaluator (the one that explains).** The `budget` evaluator registered in Phase 3 becomes real, so budget state participates in transitions like any other rule and appears in the same Checks panel. Its config:

```ts
type BudgetConfig = {
  scope: 'item' | 'project';
  warnAtRatio: number;   // 0.8
  blockAtRatio: number;  // 1.0
  message: string;
};
```

Both paths read one function (`computeBudgetState`), so the launcher and the gate can never disagree.

**Mid-run overrun** is detected at close-out, not during the run: we cannot meter a run in flight. Crossing the hard threshold mid-run pauses the item afterwards and raises the block for the *next* action — which is why `reserveMicroUsdPerRun` exists, and why the demo's "blocked mid-pipeline" is precisely that: the pipeline stops, the in-flight run is allowed to finish.

---

## 4. Data model changes

```sql
-- 0011_cost.sql
create table model_prices ( … as §3.2 … );

alter table runs
  add column cost_estimate_micro_usd bigint,
  add column cost_actual_micro_usd bigint,
  add column cost_micro_usd bigint,            -- actual when present, else estimate
  add column cost_source text check (cost_source in ('estimated','reconciled')),
  add column price_row_id uuid references model_prices(id),
  add column reconciled_at timestamptz,
  add column allocation_method text;           -- 'exact' | 'proportional' | 'sole_run'

alter table stage_instances add column cost_micro_usd bigint not null default 0;
alter table work_items
  add column budget_micro_usd bigint,
  add column budget_overridden boolean not null default false,
  add column spend_micro_usd bigint not null default 0,
  add column spend_source text not null default 'estimated',
  add column paused_reason text;
alter table projects add column spend_micro_usd bigint not null default 0;

create table budget_events (
  id uuid primary key,
  project_id uuid not null references projects(id),
  work_item_id uuid references work_items(id),
  kind text not null,   -- 'threshold_crossed' | 'blocked' | 'cap_raised' | 'budget_overridden'
                        -- 'paused' | 'resumed' | 'reconciled_delta'
  scope text not null check (scope in ('item','project')),
  before jsonb not null, after jsonb not null,
  actor jsonb not null, reason text,
  created_at timestamptz not null default now()
);
create index budget_events_project on budget_events (project_id, created_at desc);

create table cost_rollup_checks (      -- nightly drift detection
  id uuid primary key, scope text not null, subject_id uuid not null,
  stored_micro_usd bigint not null, recomputed_micro_usd bigint not null,
  drift_micro_usd bigint not null, created_at timestamptz not null default now()
);
```

`projects.settings` gains the `budget` object from §3.5. `deriveStatus` gains `budgetState`, producing `paused_budget`.

---

## 5. Interfaces

```ts
// packages/core/src/cost
estimateRunCost(ctx, runId): Result<{ micro: MicroUsd; priceRowId: string }>
recomputeRollups(ctx, { scope, id }): Result<RollupResult>
reconcileWindow(ctx, { from, to }): Result<ReconcileSummary>   // job handler

// packages/core/src/budgets
computeBudgetState(ctx, workItemId): BudgetState
  // { item: { budget, spent, ratio, state }, project: { cap, spent, ratio, state }, reservations }
checkBudget(ctx, { workItemId, reserve }): BudgetDecision
setItemBudget(ctx, workItemId, { micro, reason }): Result<WorkItem>      // marks overridden
raiseProjectCap(ctx, projectId, { micro, reason }): Result<Project>      // owner/maintainer only
pauseItem / resumeItem(ctx, workItemId, { reason }): Result<WorkItem>
```

**MCP.** `get_ticket.budget` becomes real: `{ budget_micro_usd, spent_micro_usd, ratio, state, project_state }`. An agent can see it is near a ceiling — useful context for a scoping automation deciding how much work to propose. Agents cannot change budgets; there is no MCP tool for it and there should not be.

**UI.**

- Ticket header: `$1.24 of $10.00` with a progress bar; hovering shows estimated versus reconciled composition; a per-run cost column in the run timeline.
- Board: a subtle spend indicator on cards past the soft threshold; a paused treatment for blocked items.
- Project settings: complexity budget table, burn cap, reserve, and the blocking toggle.
- Project header: burn cap progress with the same estimate/reconciled honesty.
- An **"estimate" badge** wherever any component of a figure is estimated. Not a tooltip — a visible badge.

---

## 6. Implementation steps

### Step 4.1 — Money primitives and the price table

**Changes.** `packages/core/src/cost/money.ts`; the `model_prices` schema, seed from published pricing with `effective_from`, and an admin editor (owner-only) with an audit trail; the surcharge field; the unknown-model warning path; display helpers with sub-cent handling.

**Done when.** Given a token vector and a model, the estimator returns the same figure as a hand-calculated check for three models, including one with a surcharge and one unknown.

---

### Step 4.2 — Per-run cost and rollups

**Changes.** `closeOutRun` extended to price the run and update the four rollup levels in one transaction; the nightly `recompute_cost_rollups` job with drift recording; backfill of Phase 2 runs that already have token counts; `cost.estimated` events.

**Done when.** A run's cost appears within a tick of terminal; project total equals the sum of item totals equals the sum of run costs; the nightly job reports zero drift on seeded data and non-zero on deliberately corrupted data.

---

### Step 4.3 — Reconciliation

**Changes.** `packages/cursor-client/src/admin.ts` extended with paging and rate-limit respect; the hourly `reconcile_costs` job with the matching and allocation logic of §3.4; drift storage and threshold alerting; graceful degradation (a 403 or an empty response disables reconciliation, sets a project-visible banner "reconciled costs unavailable on this plan", and leaves estimates in place).

**Done when.** At least one real run flips from estimated to reconciled with the delta recorded, and the estimate-only fallback is demonstrated by revoking the admin key in preview.

---

### Step 4.4 — Budgets and defaults

**Changes.** Project budget settings UI and validation (soft < hard; cap ≥ hard); default application on complexity set, and on complexity change when not overridden; per-item override with mandatory reason; `computeBudgetState` including reservations; `budget_events` on every change.

**Done when.** Setting complexity to High on a fresh item populates its budget from the project table; overriding it survives a later complexity change; both are recorded.

---

### Step 4.5 — Enforcement

**Changes.** `checkBudget` in `launchRun` before the provider call, with reservations; the real `budget` gate evaluator wired into Phase 3's registry; `deriveStatus` gains `paused_budget`; threshold-crossing detection at close-out emitting warnings via the Phase 3 warning system (so a soft breach becomes durable context, not a toast).

**Done when.** A launch that would exceed the item's hard threshold is refused before any provider call, with a message naming the threshold; a project burn cap refuses a launch on a *different* item; two concurrent launches cannot both slip under a cap.

---

### Step 4.6 — Overrides, pauses, and their audit

**Changes.** Raise-cap and raise-item-budget flows with mandatory reason and permission checks; pause and resume; every action writing both a `budget_event` and an `intervention`; a project **Spend** view listing budget events chronologically with actor, reason, and before/after.

**Done when.** The demo's raise-and-resume works end to end, and the Spend view tells the whole story — blocked, raised by whom, why, and resumed — without opening the database.

---

### Step 4.7 — Cost surfaces

**Changes.** All the UI in §5, plus the estimate badge treatment; per-stage cost in the stage timeline; per-run cost in the run timeline; a project cost summary card; sub-cent formatting that does not render "$0.00" for real spend.

**Done when.** Every figure in the UI can be traced to its source in two clicks, and no figure appears without its source label.

---

### Step 4.8 — Hardening and flag removal

**Changes.** A load test of rollup updates under 50 concurrent run close-outs (no lost updates — the incremental update must be an atomic `UPDATE … SET spend = spend + x`, never read-modify-write); reconciliation idempotency (running the same window twice changes nothing); a runbook section for "costs look wrong"; flag removal.

**Done when.** Reconciliation is provably idempotent and rollups survive concurrency.

---

## 7. Testing and verification

- **Unit.** Estimation maths per model including surcharge and unknown-model; micro-dollar conversions and rounding at boundaries; budget state computation including reservations; threshold crossing detection; allocation across multiple runs of one agent.
- **Integration.** Rollups after N runs across M stage instances; concurrent close-outs (assert atomic increment); reconciliation flipping source and updating every level; pre-launch refusal leaving no run row and no provider call; budget gate and launcher agreeing under the same state.
- **Property test.** For random run sequences, project spend always equals the sum of item spends, which always equals the sum of run costs, at every level of `cost_source` mixing.
- **Contract.** Admin API client against recorded fixtures including paging, 429, and the empty/403 degradation path.
- **Manual on preview.** One real agent run, priced, then reconciled an hour later, with the delta inspected by hand.

## 8. Rollout and safety

- Flag `p4.budgets`, per project. Disabled means no enforcement, but estimation and rollups still run — collecting data before enforcing it is deliberate (`Implementation Phases.md` sequencing principle 3).
- Introduce enforcement per project in `observe` mode first (reuses Phase 3's `enforcement_mode`), then switch to `enforce`.
- Reconciliation is read-only against Cursor and idempotent; it can be re-run over any window safely.
- Blocking behaviour is fail-safe in the strict sense: if budget state cannot be computed (database error, missing price), the launcher **refuses** and says why. It never launches on the assumption that things are fine.
- The Phase 2 crude spend controls (concurrency ceiling, daily cap) stay until this phase's flags are removed, then remain as a backstop.

## 9. Demo script (the proof)

1. **Configure.** In project Alpha, show the complexity budget table (Low/Medium/High soft and hard) and a project burn cap sized so the demo can cross it.
2. **Inherit.** Create a High-complexity ticket; its budget populates automatically from the table. Show the estimate badge on a zero spend.
3. **Spend.** Run two stages. Each run's cost appears in the run timeline; the ticket total and the project total both move.
4. **Soft threshold.** The third run crosses 80%: a warning appears on the ticket — durable, courtesy of Phase 3 — and the board card shows the spend indicator. Work continues.
5. **Hard threshold.** Attempt the next run: refused **before** anything is launched, with the threshold named and no Cursor agent created. The ticket reads `Paused (budget)`.
6. **Project burn cap.** On a *different* ticket in the same project, attempt a run: refused because the project cap is exhausted, with the project-level reason.
7. **Raise and resume.** A maintainer raises the cap with a reason. Both tickets become runnable; run one to prove it. Open the Spend view: block, override with actor and reason, and resumption, all recorded.
8. **Honesty.** Show a run labelled estimated, then show one that reconciliation has flipped to reconciled with the delta from the original estimate. If the plan tier does not expose reconciled charges, show the banner that says so instead.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| Reconciled costs unavailable on our tier | Step 4.3 returns 403 or empty | Estimate-only mode with a permanent, honest banner; decided in Phase 0 step 0.7, not discovered here |
| Price table drifts from reality | Reconciliation deltas trend one way | Store per-run drift; alert past 30%; the Spend view charts estimate versus actual |
| Agent-to-run cost allocation is wrong | Multi-run agents show implausible splits | Proportional allocation by token counts, method recorded per run; prefer exact matching when Phase 0 confirmed a per-run key |
| Concurrency defeats the cap | Spend exceeds the cap by roughly one run | Reservations for in-flight runs; the pre-launch check is inside the work item's advisory lock |
| Budgets block the demo unhelpfully | Everything is paused ten minutes in | Placeholder numbers are chosen to be crossable but generous; `observe` mode and the flag are one click away |
| Rollup drift from lost updates | Nightly job reports non-zero drift | Atomic increments only; drift is reported rather than silently repaired |
| Cost data becomes a distraction from the thesis | Stakeholders debate pricing accuracy in the demo | Lead with the block-and-override behaviour; treat exact figures as secondary and say so |

## 11. Exit criteria

- [ ] Every terminal run carries a cost with an explicit source.
- [ ] Rollups are correct and provably consistent at all four levels.
- [ ] Reconciliation works, or its unavailability is handled and visibly disclosed.
- [ ] Complexity sets item budgets automatically; overrides persist and are recorded.
- [ ] A hard item threshold refuses a launch **before** the provider is called.
- [ ] A project burn cap blocks work on an item that has its own headroom.
- [ ] Raising a cap resumes work; block and override are both audited.
- [ ] Soft thresholds produce durable warnings, not transient ones.
- [ ] No cost figure appears in the UI without its source.
- [ ] `get_ticket` exposes budget state to agents.

## 12. Open questions for this phase

- **Q8** — price table ownership and refresh cadence. Default: seeded at kickoff, versioned, owner-editable, drift-monitored.
- **Q9** — the actual budget numbers. Placeholders are documented; real ones need a human before a pilot.
- **Local:** should crossing a hard threshold mid-run cancel the in-flight run? Recommendation: no. Cancelling loses the work already paid for; pause afterwards and let the human decide.
- **Local:** should Phase 7's agentic gate LLM calls count against the item budget? Recommendation: yes, tracked as `runs` rows with `adapter = 'internal_llm'` so nothing spends invisibly.
