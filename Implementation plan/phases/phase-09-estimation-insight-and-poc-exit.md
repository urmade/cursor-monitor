# Phase 9 — Estimation, insight, and PoC exit

> **Outcome.** "The system predicts before it spends, reports on itself, and passes its own acceptance test. New tickets show a cost range derived from complexity, labels, project, and historical spend, with an honest cold-start behaviour before enough history exists. Thin analytics report cost per item, spend against budget, rework rate, and gate Pass/Warn/Block rates. Access control is complete enough for real use, and every §16 success criterion in `VISION.md` is demonstrated end to end."
>
> **Proof.** The eight success criteria in `VISION.md` §16 are walked through in one sitting on a clean environment. A new ticket shows a plausible cost range that a retrospective check confirms against actuals. A project with too little history shows the complexity default and says so rather than inventing a number.
>
> **Milestone.** M5 — PoC complete. **Depends on.** Phase 4 (cost history), Phase 5 (rework), Phase 7 (gate outcomes), and all prior phases for the walkthrough. **Unblocks.** The go/no-go decision on the expansion backlog.

---

## 1. Objective and scope

Phase 9 has three jobs that only look unrelated: predict, report, and prove.

The prediction is the most easily overdone. A cost range is a decision aid, not a model — and the way it fails is by looking more confident than it is. `VISION.md` §5.3 asks for "a range (p50–p90 style or low/likely/high), not a false point estimate", with an honest cold start. That is achievable with quantiles over comparable historical items and nothing cleverer. Anything more sophisticated cannot be validated on PoC-scale data, so building it would be a way of pretending.

The reporting is deliberately thin (`VISION.md` §F13): four numbers that a team would act on, not a dashboard product.

The proving is the actual deliverable of the phase, and of the whole plan. Every prior phase's demo showed one capability; this one shows the thesis on a clean environment, in one sitting.

### In scope

Comparable selection and the quantile estimator with cold-start behaviour; a walk-forward backtest that measures whether the estimates were any good; estimate surfaces on item creation and on the board; the four thin analytics with their supporting views; access control completion and hardening; a clean-environment acceptance walkthrough of `VISION.md` §16; the go/no-go pack.

### Out of scope

| Not in Phase 9 | Where it goes |
|---|---|
| Trust index and progressive autonomy | Expansion backlog |
| Model leaderboards and comparisons | Expansion backlog |
| Intervention-to-rule effect measurement | Expansion backlog (data is being collected) |
| Per-scope autonomy | Expansion backlog |
| A machine-learned estimator | Not until there is far more data than a PoC produces |
| Cross-organisation benchmarking | Not planned |

---

## 2. Preconditions

- Phases 4, 5, and 7 complete, since cost history, rework, and gate outcomes are the inputs.
- Enough history to estimate from. This is a real dependency, not a formality: the phase needs several dozen completed items with reconciled or estimated costs across complexity tiers. If the PoC has not generated them, **run a data-generation week** with the seeded demo projects before starting step 9.2, and say so in the results.
- Q11 answered or defaulted: the minimum history before a range is shown (default: 5 comparable items).
- Q12 answered: the final role matrix, which step 9.6 implements.

---

## 3. Technical approach

### 3.1 Comparables

An estimate is the distribution of what similar work actually cost. "Similar" is defined narrowly first, then widened until there is enough data, and the UI always says which tier was used:

| Tier | Definition | Minimum n |
|---|---|---|
| 1 | Same project, same complexity, ≥1 shared label | 5 |
| 2 | Same project, same complexity | 5 |
| 3 | Same organisation, same complexity, same pipeline template | 8 |
| 4 | Cold start — no estimate | — |

Comparables are **completed** items only (reached a terminal stage), excluding abandoned ones and outliers beyond 3× the interquartile range — a single runaway item would otherwise dominate a small sample. Reconciled costs are preferred over estimated when available, and the tier label records the mix.

### 3.2 The estimator

```ts
// packages/core/src/estimates/estimate.ts
export type CostEstimate =
  | { kind: 'range'; tier: 1|2|3; n: number;
      p50MicroUsd: MicroUsd; p90MicroUsd: MicroUsd; lowMicroUsd: MicroUsd;  // p10
      basis: string;                       // "12 similar High items in ACME"
      computedAt: Date; sourceMix: 'reconciled' | 'estimated' | 'mixed' }
  | { kind: 'cold_start'; defaultBudgetMicroUsd: MicroUsd; n: number;
      reason: 'insufficient_history';
      basis: string };                     // "only 2 comparable items — showing the High default"
```

Empirical quantiles with linear interpolation. No distribution fitting, no regression, no smoothing: with n between 5 and 50 those techniques add assumptions, not accuracy.

Estimates are computed on demand and cached for an hour per (project, complexity, label-set) key, and invalidated when an item completes. They are also snapshotted onto the work item at creation (`estimate_at_creation`), which costs one row and makes the backtest possible — and makes it impossible to quietly revise a prediction after the fact.

### 3.3 Honest cold start

Below the threshold the UI shows the complexity default budget and says exactly why:

> **No estimate yet.** Only 2 comparable High items in this project. Showing the High default budget of $100. A range appears after 5.

This is a product statement, not a fallback. A system that invents a number from two data points teaches its users to distrust every number it shows.

### 3.4 Backtesting

Walk-forward evaluation, run as a job and reported in the admin view:

```
for each completed item, ordered by completion:
    rebuild the estimate using only items completed strictly before it
    compare to its actual cost
report: coverage  = share of actuals inside [p10, p90]     (target ≈ 80%)
        p50 bias  = median(actual / p50)                    (target ≈ 1.0)
        MAPE at p50
        breakdown by complexity and by tier
```

Coverage is the honest measure: an 80% interval that contains 40% of actuals is worse than useless. If coverage is poor, the response is to widen the interval or raise the minimum n — not to hide the metric. The backtest report is part of the phase's demo, including whatever it says.

### 3.5 Thin analytics

Four numbers, each answering a question a team would act on:

| Metric | Question | Source |
|---|---|---|
| Cost per item (median, p90, by complexity) | What does work cost here? | `work_items.spend_micro_usd` |
| Spend versus budget | Are we sizing budgets right? | spend ÷ budget, distribution + overrun count |
| Rework rate and cost share | How much are we redoing? | Phase 5's views |
| Gate Pass/Warn/Block rates, per gate | Are our gates useful or noise? | `gate_evaluations` |

Two supporting figures, cheap because the data is already there: **human touch count** per item (from `interventions`) — the closest measure of the thesis, since the product's claim is that it reduces human touches — and **median time in stage** by stage.

All of it is materialised nightly into a small `analytics_daily` table and rendered on one page. Nothing is real-time; nothing needs to be.

### 3.6 Access control completion

Phase 1 shipped a proposed matrix; Phase 9 finalises and proves it. The work is a permission audit rather than new features: enumerate every action across UI, MCP, API, and jobs; assert each against the matrix in a test; review the service-account and token inventory; verify cross-project isolation everywhere (including that a token for project A cannot read project B, and that a run token cannot touch a second work item); confirm that no surface leaks the existence of resources a user cannot see.

---

## 4. Data model changes

```sql
-- 0016_estimates_analytics.sql
alter table work_items
  add column estimate_at_creation jsonb,       -- CostEstimate snapshot; enables backtesting
  add column estimate_tier integer;

create table estimate_cache (
  key text primary key,                        -- hash(project, complexity, label set)
  estimate jsonb not null,
  computed_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table estimate_backtests (
  id uuid primary key,
  project_id uuid references projects(id),      -- null = organisation-wide
  ran_at timestamptz not null default now(),
  sample_size integer not null,
  coverage numeric(4,3) not null,               -- share within [p10,p90]
  p50_bias numeric(6,3) not null,
  mape numeric(6,3) not null,
  by_complexity jsonb not null, by_tier jsonb not null,
  detail jsonb not null
);

create table analytics_daily (
  day date not null,
  project_id uuid not null references projects(id),
  metrics jsonb not null,                       -- all §3.5 figures for the day
  computed_at timestamptz not null default now(),
  primary key (day, project_id)
);
```

Plus read-only SQL views (`v_item_costs`, `v_rework`, `v_gate_outcomes`, `v_human_touches`, `v_stage_durations`) so the analytics job and any ad-hoc query share one definition of each metric. A metric defined twice will eventually disagree with itself.

---

## 5. Interfaces

```ts
// packages/core/src/estimates
estimateForNewItem(ctx, { projectId, complexity, labelKeys }): Promise<CostEstimate>
estimateForItem(ctx, workItemId): Promise<CostEstimate>
runBacktest(ctx, { projectId? }): Promise<BacktestResult>

// packages/core/src/analytics
computeDaily(ctx, day): Promise<void>                    // nightly job
projectAnalytics(ctx, projectId, window): Promise<AnalyticsSummary>
```

**MCP.** `get_ticket` gains `estimate` — a scoping automation that knows similar work has cost $40 can size its proposal accordingly, which is one of the more genuinely useful things we can tell an agent.

**API.** `GET /api/v1/projects/{key}/analytics` and `GET /api/v1/work-items/{key}/estimate`, both read-only, both `projects:read`.

**UI.**

- **Item creation:** as complexity is chosen, the estimate appears inline — "Similar High items in ACME have cost $18–$62 (median $31), based on 12 items" or the cold-start message.
- **Ticket header:** estimate alongside budget and actual spend; once complete, the estimate-versus-actual comparison, which is the most trust-building element in the whole feature.
- **Board:** estimate on unstarted cards, actual on started ones.
- **Project analytics page:** the four metrics plus the two supporting figures, with a window selector and a link to the backtest report.
- **Admin:** backtest results, reconciliation health, attention drift, queue depth — the "is this system honest" page.

---

## 6. Implementation steps

### Step 9.1 — Comparables and the estimator

**Changes.** Comparable selection with the tier ladder and outlier trimming; empirical quantiles; the cold-start path; the cache with completion-triggered invalidation; the creation-time snapshot; `estimateForNewItem` and `estimateForItem`.

**Done when.** Against seeded history the estimator returns hand-verifiable quantiles, tiers widen only when the minimum n is unmet, and a project with three items returns cold start rather than a range.

---

### Step 9.2 — Estimate surfaces

**Changes.** Inline estimate on item creation that updates with complexity and labels; ticket header treatment; board display; estimate-versus-actual on completion; copy that states the basis (`n`, tier, source mix) everywhere a number appears — never a bare figure.

**Done when.** Every displayed estimate states what it is based on, and cold start reads as a deliberate answer rather than a missing value.

---

### Step 9.3 — Backtesting

**Changes.** The walk-forward harness; coverage, bias, and MAPE with breakdowns; a job running it nightly and on demand; the admin report with a plain-language interpretation ("intervals are too narrow: 52% coverage against a target of 80%"); a documented response procedure (widen the interval, raise minimum n, or investigate the price table).

**Done when.** A backtest over the accumulated history produces the four figures with breakdowns, and the interpretation is legible to a non-statistician.

---

### Step 9.4 — Analytics

**Changes.** The SQL views; the nightly `analytics_daily` job with backfill; the project analytics page; the human-touch and stage-duration figures; CSV export for anyone who wants to do their own analysis.

**Done when.** Every metric on the page reconciles with a hand-run query on the same data, and the page loads from `analytics_daily` rather than recomputing.

---

### Step 9.5 — Access control completion and hardening

**Changes.** The finalised matrix implemented and documented in `docs/access-control.md`; a permission test per action per role, generated from the matrix so a new action without a test fails CI; cross-project isolation tests across UI, MCP, and API; a token and service-account inventory review; a check that no endpoint leaks resource existence; a rate-limit review across every public surface.

**Done when.** The generated permission suite is complete and green, and an unauthorised access attempt on every surface fails identically (404, not 403, for resources whose existence is itself private).

---

### Step 9.6 — The clean-environment acceptance walkthrough

**Goal.** Prove all eight `VISION.md` §16 criteria in one sitting on an environment nobody has been tinkering with.

**Changes.** `pnpm acceptance:setup` provisioning a clean project with pipeline, labels, budgets, gates, bindings, and rubrics from a declarative fixture; a written script mapping each criterion to the exact actions and expected observations; a Playwright suite covering the deterministic parts (everything except real agent runs, which are performed live); a rehearsal on preview with issues fixed before the real walkthrough.

| § | Criterion | Where it is shown |
|---|---|---|
| 1 | Project with stages, labels, complexity budgets, burn cap | Setup, shown live |
| 2 | Gates including a human gate and an agentic Pass/Warn/Block | Steps 3–5 of the script |
| 3 | Bind existing automations, run with ticket ID, audited with time and cost | Steps 2 and 6 |
| 4 | Agents fetch and update spec via MCP; labels honoured by gates | Steps 2 and 4 |
| 5 | Inbox answering and approving without manual status updates | Step 7 |
| 6 | Loops visible when work returns | Step 8 |
| 7 | Deploy as terminal stage | Step 9 |
| 8 | Cost range estimate from complexity and history | Step 1 and step 10 |

**Done when.** The full script has been walked twice on a clean environment, once as a rehearsal and once for real, with the observations recorded.

---

### Step 9.7 — The go/no-go pack

**Changes.** `docs/poc-results.md`: what was proven, what was not, measured figures (estimate accuracy, rework rate, gate outcome rates, human touches per item, cost per item), known gaps, and the operational limits discovered. `docs/runbook.md` completed for every recurring failure mode. A prioritised expansion-backlog recommendation grounded in what the PoC actually showed rather than in the original vision's ordering. An honest limitations section — the things a pilot team would hit in week one.

**Done when.** Someone who was not involved can read the pack and make the go/no-go decision without a meeting.

---

## 7. Testing and verification

- **Unit.** Quantile computation against known distributions; tier selection and widening; outlier trimming; cold-start thresholds; backtest maths on a synthetic dataset with a known answer.
- **Integration.** Estimates against a seeded history of 100 completed items; cache invalidation on completion; analytics job output matching direct queries; permission matrix generation covering every registered action.
- **Backtest validation.** Inject a synthetic history with a known cost distribution and assert the harness recovers approximately correct coverage — testing the measuring instrument before trusting its measurements.
- **End-to-end.** The acceptance walkthrough's deterministic portion automated in Playwright against a clean preview environment.
- **Regression sweep.** The full suite from every prior phase, run once against the clean environment before the walkthrough. Phase 9 is where accumulated drift shows up.

## 8. Rollout and safety

- Flag `p9.estimates`. Analytics ships unflagged (read-only, additive).
- Estimates are advisory: they never automatically set a budget. Budgets stay complexity-driven with explicit overrides, because an estimate that silently becomes a cap would make the block behaviour unpredictable.
- The backtest is read-only and can be re-run over any window.
- The acceptance environment is separate from any pilot data.
- No new external dependencies in this phase — a deliberate choice, since it is the phase most likely to be under time pressure.

## 9. Demo script (the proof)

The clean-environment walkthrough, roughly forty-five minutes. It is the PoC's final demo and it should be run start to finish without shortcuts.

1. **Set up a project (criterion 1).** Pipeline, label taxonomy, complexity budgets, project burn cap — all configured live in the UI, on a project that did not exist ten minutes ago.
2. **Estimate before spending (criterion 8, part one).** Create a High-complexity ticket; the range appears from history. Create one in a fresh project with no history; the cold-start message appears instead. Contrast them explicitly.
3. **Gates (criterion 2).** Show a human approval gate on Ready, a deterministic gate requiring complexity, and an agentic rubric on spec quality. Show that none of it touched a repository.
4. **Agent work through MCP (criteria 3 and 4).** Run the scoping automation with only a ticket id. Watch it read and write through MCP, set labels, and post its report. Show the run's duration, tokens, and cost.
5. **Warn and Block.** The agentic gate warns on a borderline spec; a deterministic gate blocks on the agent-set `risk:high` label. Both are legible on the ticket, and the warning is durable.
6. **Approve and proceed (criterion 5, part one).** Approve the human gate from the inbox; the held transition completes on its own.
7. **Question and resume (criterion 5, part two).** An implementation run asks a blocking question. Answer it from the inbox; work resumes without anyone touching a stage field.
8. **Loop (criterion 6).** Send the work back from Review with a reason code. The ribbon shows the arc; the loop cost is attributed; a second return triggers the loop warning.
9. **Budget (still criterion 1).** Cross the soft threshold, then the hard one; the launch is refused before spending. Raise the cap with a reason; work resumes; both are audited.
10. **Deploy and close (criteria 7 and 8, part two).** Reach Deploy — terminal, nothing further runs. Compare the item's actual cost to the estimate from step 2. Then open the analytics page: cost per item, spend versus budget, rework rate, gate outcome rates, human touches. Finish on the backtest report, whatever it says.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| Not enough history to estimate from | Every project shows cold start | Recognised as a precondition; run a data-generation week before step 9.2 rather than discovering it during the demo |
| Estimates look authoritative and are not | Someone quotes p50 as a commitment | Always a range, always with n and basis; the backtest is shown publicly; estimates never set budgets automatically |
| Backtest embarrasses the feature | Coverage far below 80% | Report it and respond — widen intervals or raise minimum n. Suppressing the measurement would be worse than a poor result |
| Analytics become the product | Requests for charts, filters, comparisons | Four metrics plus two supporting figures. CSV export absorbs the rest |
| Accumulated regressions surface late | The walkthrough fails on something built in Phase 3 | Full regression sweep and a rehearsal before the real walkthrough |
| Access control gaps found at the end | Permission audit turns up real holes | The audit is a step with its own tests, and the generated matrix suite fails CI when an action lacks coverage |
| The walkthrough overruns | Forty-five minutes becomes ninety | Rehearse; pre-warm agent runs where honest to do so; keep a recorded fallback for the live-agent steps |

## 11. Exit criteria

- [ ] Cost ranges are shown for new tickets with basis, sample size, and tier stated.
- [ ] Cold start is honest and explains itself.
- [ ] A backtest reports coverage, bias, and MAPE, with breakdowns and a plain-language interpretation.
- [ ] Estimate-versus-actual is visible on completed items.
- [ ] The four thin analytics plus human touch count and stage durations are correct and reconcile with direct queries.
- [ ] The access control matrix is complete, documented, and covered by a generated permission suite.
- [ ] Cross-project isolation holds across UI, MCP, and API.
- [ ] All eight `VISION.md` §16 criteria are demonstrated on a clean environment in one sitting.
- [ ] `docs/poc-results.md` and `docs/runbook.md` are complete.
- [ ] An expansion-backlog recommendation exists, grounded in what the PoC measured.

## 12. Open questions for this phase

- **Q11** — minimum history before showing a range. Default 5; the backtest gives evidence to revise it, and revising it on evidence is the intended path.
- **Q12** — final role matrix, implemented in step 9.5.
- **Local:** should estimates cover time as well as money? Recommendation: yes, using the same machinery on stage durations — it is nearly free and "how long will this take" is asked more often than "what will it cost".
- **Local:** should the estimate widen automatically when the backtest shows poor coverage? Recommendation: no automatic tuning in the PoC. Report it, decide deliberately, record the change. Self-tuning thresholds are explicitly out of scope (`VISION.md` §3), and an estimator that silently changes its own behaviour is exactly the kind of thing the honesty principle argues against.
