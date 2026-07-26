# Phase 5 — Loops and rework

> **Outcome.** "Backward movement is a first-class, visible fact rather than an absence of progress. Every return to an earlier stage is recorded with a reason code and a trigger. A ticket shows how many times it has looped, between which stages, and what that looping has cost in time and money. A project can set a loop budget that warns or escalates when a ticket cycles too often."
>
> **Proof.** A ticket is sent back from a review-like stage to implementation twice. The ticket shows a loop count, the two return edges with their reasons, and the cumulative cost of the looping. A loop budget triggers an escalation on the third return.
>
> **Depends on.** Phase 1 (transitions), Phase 2 (stage instances), Phase 4 (cost attribution). Independent of Phase 6; can be built in parallel with Phase 7. **Unblocks.** Loop escalations as an attention source; Phase 9's rework metrics.

---

## 1. Objective and scope

Rework is the most honest signal an agentic pipeline produces. A ticket that reaches Deploy after four returns cost far more than its stage count suggests, and the pattern of *where* it returns from says more about the process than any velocity metric.

The whole phase rests on one definition, so it is worth stating precisely before any code:

> **A loop is a visit to a stage the work item has already visited.** The transition that causes it is a **return edge**. Everything a loop costs is the cost of the visits that were not the first.

That definition is computable from data Phase 1 and Phase 2 already record (`stage_instances.seq`, `transitions.direction`), which is why this phase is small despite being conceptually rich. Phases 1 and 2 paid for it in advance.

### In scope

Return edge semantics and a project-configurable reason-code taxonomy; loop counting per item and per stage pair; rework time and cost attribution; loop budget policy with warn, escalate, and block outcomes; the journey ribbon and loop panel on the ticket; a loop badge on the board; the rework-rate query Phase 9 will report on.

### Out of scope

| Not in Phase 5 | Lands in |
|---|---|
| Loop escalations in a ranked inbox | Phase 6 (this phase emits the signal) |
| Cross-project loop hotspot analytics | Phase 9, thinly |
| Automatic strategy changes in response to looping (different model, different automation) | Expansion backlog |
| Predicting which tickets will loop | Not planned |

---

## 2. Preconditions

- Phase 4 complete: without cost attribution, "what the looping cost" is only time, and half the point is lost.
- Phase 3's gate engine, since the loop budget is expressed as a gate rather than as bespoke logic.
- A default reason-code taxonomy agreed with whoever will use it — see step 5.1.

---

## 3. Technical approach

### 3.1 Return edges and reason codes

A transition is a return edge when `direction = 'backward'` **and** the target stage has a previous `stage_instances` row for the item. Backward movement into a never-visited stage (a pipeline reorder, or skipping backwards to a stage that was jumped over) is recorded as backward but is not a loop; conflating the two inflates rework metrics with pipeline edits.

Reason codes are project-configurable with a seeded default set, because "why did this come back" is the field teams will actually mine:

| Code | Meaning |
|---|---|
| `review_findings` | Review-like stage found problems |
| `spec_gap` | The specification was insufficient or wrong |
| `failed_verification` | Tests, checks, or acceptance failed |
| `changed_requirements` | The ask changed underneath the work |
| `agent_error` | The run did the wrong thing |
| `human_direction` | A person chose to redo it, no fault implied |
| `gate_block` | A gate sent it back (auto-populated) |
| `other` | Requires a note |

A reason code is **required** on any manual return edge (the UI cannot submit without one) and auto-populated when the return is caused by a gate or by a report with `outcome: 'failed' | 'blocked'`. `other` demands free text. Requiring the code at the moment of the return is the only way to get trustworthy data — asking later never works.

### 3.2 Counting

Three counters, each answering a different question:

| Counter | Question | Storage |
|---|---|---|
| `work_items.loop_count` | How rework-heavy is this ticket? | Denormalised, incremented on each return edge |
| `loop_edges` rows | Where does this ticket cycle? | One row per return edge with from/to, reason, trigger, cost snapshot |
| `stage_instances.seq` / visit index | How many times has it been in *this* stage? | Already recorded since Phase 1 |

Loop budgets can be expressed against any of them: total returns on the item, returns into a specific stage, or returns on a specific stage pair (Review → Implementation is the interesting one).

### 3.3 Rework cost and time

```
rework_cost(item) = Σ cost_micro_usd  of stage_instances where visit_index > 1
rework_time(item) = Σ (exited_at - entered_at) of the same instances
loop_edge.cost    = cost accumulated between this return edge and the next forward
                    departure from the stage it returned to
```

`visit_index` — the ordinal of a visit to a particular stage — is materialised on `stage_instances` at insert time (`count of prior instances of the same item+stage, plus one`) rather than computed on read. It makes every rework query a simple filter and it never changes after the fact.

The per-edge cost is the number a human actually wants: "this bounce cost $6.40 and two hours". It is finalised when the item leaves the returned-to stage again, so an in-flight loop shows a running total flagged as incomplete.

### 3.4 Loop budgets as gates

Rather than a parallel enforcement mechanism, the loop budget is a Phase 3 gate with a new evaluator, `loop_budget`:

```ts
type LoopBudgetConfig = {
  scope: 'item' | 'stage' | 'stage_pair';
  stageId?: string; fromStageId?: string; toStageId?: string;
  warnAt: number;        // e.g. 2
  escalateAt: number;    // e.g. 3
  blockAt?: number;      // optional hard stop
  message: string;
};
```

Outcomes map onto the engine's existing vocabulary: `warnAt` produces a durable warning, `escalateAt` produces a warning plus a `loop.escalated` event and sets `work_items.loop_escalated` (which `deriveStatus` reflects and Phase 6 turns into an inbox item), and `blockAt` blocks further transitions until a human intervenes. This reuse is the whole reason Phase 3 came first.

Escalation is deliberately *not* a block by default. A ticket that has looped three times usually needs a human to look at it, not to be frozen — and freezing it removes the very run data that would explain why it keeps looping.

### 3.5 The journey ribbon

A compact horizontal visualisation of the item's actual path, not its intended one:

```
Intake ──► Scoping ──► Plan ──► Impl ──► Review ──┐
                                  ▲               │  review_findings · $4.10 · 3h
                                  └───────────────┘
                                  ▼
                               Impl(2) ──► Review(2) ──► Deploy
```

Rendered from `stage_instances` plus `transitions`, with return edges drawn as arcs carrying reason and cost. It is the one visual in the product that makes the cost of rework immediately legible, and it should be the first thing on a looped ticket.

---

## 4. Data model changes

```sql
-- 0012_loops.sql
alter table stage_instances
  add column visit_index integer not null default 1,     -- backfilled from seq ordering
  add column is_rework boolean generated always as (visit_index > 1) stored;

alter table transitions
  add column is_return_edge boolean not null default false,
  add column loop_edge_id uuid;

alter table work_items
  add column loop_count integer not null default 0,
  add column rework_cost_micro_usd bigint not null default 0,
  add column rework_ms bigint not null default 0,
  add column loop_escalated boolean not null default false;

create table loop_reason_codes (
  id uuid primary key,
  project_id uuid not null references projects(id),
  code text not null, label text not null,
  requires_note boolean not null default false,
  position integer not null default 0,
  archived_at timestamptz,
  unique (project_id, code)
);

create table loop_edges (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  transition_id uuid not null references transitions(id) unique,
  from_stage_id uuid not null references stages(id),
  to_stage_id uuid not null references stages(id),
  reason_code text not null, note text,
  trigger jsonb not null,          -- { kind: 'human'|'gate'|'report', by, ref }
  occurred_at timestamptz not null default now(),
  closed_at timestamptz,           -- when the item next left to_stage forwards
  cost_micro_usd bigint,           -- finalised at closed_at
  duration_ms bigint,
  cost_complete boolean not null default false
);
create index loop_edges_item on loop_edges (work_item_id, occurred_at);
create index loop_edges_pair on loop_edges (from_stage_id, to_stage_id);
```

Backfill: `visit_index` is computed for existing rows by ordering each item's stage instances by `seq`; existing backward transitions become `loop_edges` with `reason_code = 'unknown'` so historical items do not silently read as loop-free.

---

## 5. Interfaces

```ts
// packages/core/src/loops
recordReturnEdge(ctx, { transitionId, reasonCode, note, trigger }): Result<LoopEdge>
closeLoopEdge(ctx, loopEdgeId): Result<LoopEdge>            // on forward departure
getLoopSummary(ctx, workItemId): LoopSummary
  // { count, edges: LoopEdge[], reworkCost, reworkMs, byStagePair, escalated }
projectReworkStats(ctx, projectId, window): ReworkStats      // feeds P9
```

Phase 1's `transitionWorkItem` gains a required `reasonCode` when the move is a return edge; the type system enforces it (a discriminated union on the input, not a runtime check), so no caller can create an unexplained return.

**MCP.** `get_ticket` gains `loops: { count, last_reason, escalated }`. This matters more than it looks: an implementation automation that knows it is on the third attempt after `review_findings` can behave differently — and it is exactly the kind of context that is cheap for us to provide and impossible for the agent to discover.

**UI.**

- **Ticket:** the journey ribbon at the top of the timeline; a Loops panel listing each return edge with reason, trigger, duration, and cost; rework totals in the header next to total spend.
- **Board:** a loop badge (`↻2`) on cards with returns, and a distinct treatment for escalated items.
- **Project settings:** the reason-code taxonomy editor and the loop budget gate configuration.
- **Return dialog:** choosing an earlier stage opens a required reason-code picker with an optional note; `other` requires the note.

---

## 6. Implementation steps

### Step 5.1 — Return edges and the reason taxonomy

**Changes.** `loop_reason_codes` seeded per project from the default set of §3.1; taxonomy editor in project settings; return-edge detection in `transitionWorkItem`; the required reason code enforced in the type signature; auto-population for gate- and report-triggered returns; the return dialog in the UI.

**Done when.** No return edge can be created without a reason code through any surface, including MCP and (later) the public API, and the taxonomy is editable per project.

---

### Step 5.2 — Loop detection, counters, and backfill

**Changes.** `visit_index` materialisation on stage-instance insert; `loop_edges` creation; `work_items.loop_count` increment in the same transaction; the backfill migration for existing data; `loop.detected` events.

**Done when.** A ticket sent back twice shows `loop_count = 2` with two `loop_edges` rows; backfilled historical items show plausible counts; a backward move into a never-visited stage does **not** count as a loop.

---

### Step 5.3 — Rework cost and time attribution

**Changes.** Rollup extension so run costs also accumulate into `rework_cost_micro_usd` when the stage instance is rework; per-edge cost finalisation on forward departure (`closeLoopEdge`); running totals for open edges flagged incomplete; inclusion in the nightly recompute and drift check from Phase 4.

**Done when.** For a ticket that looped twice, rework cost equals the sum of second-and-later visit costs, verified by hand against the run list, and an in-flight loop shows a provisional figure that is visibly provisional.

---

### Step 5.4 — Loop budget gate and escalation

**Changes.** The `loop_budget` evaluator registered in Phase 3's registry; configuration UI on the chosen policy surface; warn, escalate, and optional block behaviour; `loop.escalated` event and the `loop_escalated` flag; `deriveStatus` reflecting escalation; escalation notification through the Phase 2 notification path if one exists, otherwise queued for Phase 6.

**Done when.** A loop budget of warn 2 / escalate 3 produces a durable warning on the second return and an escalation on the third, with the ticket still workable unless `blockAt` is configured.

---

### Step 5.5 — Journey ribbon and loop surfaces

**Changes.** The ribbon component (`packages/ui/src/journey-ribbon.tsx`) rendering stage instances and return arcs, with accessible text alternatives and sensible degradation for items with many loops (collapse repeated pairs with a count); the Loops panel; board badges; escalated treatment.

**Done when.** A ticket with five loops renders legibly, a ticket with none renders as a plain line with no visual noise, and the ribbon is readable by a screen reader.

---

### Step 5.6 — Rework metrics groundwork

**Changes.** SQL views for rework rate (share of items with at least one loop), loops per item distribution, mean loop cost, and top stage pairs by return volume; `projectReworkStats`; a single project-level card showing rework rate this month with a link to the item list filtered to looped items.

**Done when.** The views return correct numbers against the seeded demo data, verified against hand-counted expectations, and Phase 9 can consume them without new queries.

---

### Step 5.7 — Hardening and flag removal

**Changes.** Correct handling of a stage archived after loops through it (edges still render with the historical name); pipeline reordering after loops (the ribbon renders the historical path, not the current pipeline order); an index review for the loop queries; runbook section "loop counts look wrong".

**Done when.** Reordering a pipeline does not change any historical ribbon, and archiving a looped-through stage does not break the ticket page.

---

## 7. Testing and verification

- **Unit.** Return-edge detection including the never-visited-stage case; `visit_index` computation; rework cost aggregation; loop budget threshold logic across all three scopes.
- **Integration.** A scripted item life with three loops asserting counters, edges, and costs at each step; backfill correctness on a fixture database; a gate-triggered return auto-populating its reason; pipeline reorder leaving history intact.
- **Property test.** For random transition sequences, `loop_count` always equals the number of `loop_edges`, and rework cost never exceeds total spend.
- **Visual.** Snapshot tests of the ribbon for zero, one, five, and twenty loops.

## 8. Rollout and safety

- Flag `p5.loops`. Detection and recording can be enabled before the loop budget gate, so data accumulates before enforcement — the same "observe before enforce" order used in Phases 3 and 4.
- The backfill migration is idempotent and re-runnable.
- Escalation defaults to non-blocking; `blockAt` is opt-in per project.
- No new external dependencies: this phase touches nothing outside our database.

## 9. Demo script (the proof)

1. **Set up.** In project Alpha, show the reason-code taxonomy and a loop budget gate configured warn 2 / escalate 3 on the Review → Implementation pair.
2. **First return.** Take a ticket at Review back to Implementation, choosing `review_findings` with a note. The ribbon gains an arc; the ticket shows `↻1`.
3. **Do the work again.** Run the implementation stage; note the cost attributed to the second visit and separated as rework.
4. **Second return.** Return again with `failed_verification`. `↻2`, a durable warning appears from the loop budget, and the Loops panel now shows two edges with their reasons, durations, and costs.
5. **Third return.** `↻3` triggers the escalation: the event fires, the item is flagged escalated, and the board card shows the escalated treatment. The ticket is still workable — explain why that is deliberate.
6. **The cost of rework.** Show the ticket header: total spend versus rework spend, and the same split in time. Then the project rework-rate card.
7. **History is stable.** Reorder the project's pipeline and reload the ticket: the ribbon still shows the path the work actually took.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| Reason codes are ignored or always `other` | `other` dominates the distribution | Required at the moment of return, small default set, `other` requires a note, and the distribution is reported in Phase 9 so bad taxonomies are visible |
| Loop cost is disputed | "That bounce didn't really cost that" | The definition is stated in the UI ("cost of visits after the first"), and every figure links to the runs it came from |
| Escalation becomes noise | Everything is escalated | Defaults are conservative (3), thresholds are per stage pair rather than global, and escalations resolve when the item next moves forward |
| Ribbon unreadable on heavily looped items | Twenty arcs in one row | Collapse repeated pairs with counts; provide a table fallback |
| Pipeline edits corrupt history | A reorder changes past directions | `direction` is computed and stored at write time (Phase 1 decision); the ribbon renders from stored history only |
| Rework metrics mistaken for a productivity score | Loop counts used to judge people | The UI frames rework as process signal; Phase 9 reports it per project and per stage pair, never per person |

## 11. Exit criteria

- [ ] Every return edge carries a reason code and a trigger; none can be created without one.
- [ ] Loop counts are correct per item, per stage, and per stage pair, and exclude backward moves into never-visited stages.
- [ ] Rework cost and time are attributed and reconcile with total spend.
- [ ] Per-edge cost is finalised on forward departure and provisional before it.
- [ ] A loop budget warns, escalates, and (optionally) blocks, using the Phase 3 engine rather than parallel logic.
- [ ] The journey ribbon renders the historical path and survives pipeline edits.
- [ ] `get_ticket` exposes loop context to agents.
- [ ] Rework-rate views return verified numbers for Phase 9.

## 12. Open questions for this phase

- **Local:** should a loop escalation notify immediately, or wait for Phase 6's inbox? Recommendation: emit the event now and, if a Slack channel is already wired, post there; the inbox is the real home.
- **Local:** should returning to a stage *skip* re-running its bound automation, or re-run it automatically? Recommendation: never auto-run on a return in the PoC — a loop is precisely the moment a human should choose what happens next.
- **Local:** do we count a resume run (Phase 2's answer-to-question follow-up) as rework? Recommendation: no. It is a continuation within the same stage visit, not a return; conflating them would make every answered question look like a loop.
