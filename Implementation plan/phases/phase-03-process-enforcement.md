# Phase 3 — Process enforcement

> **Outcome.** "The system enforces the process a team defines. Gates exist per project, are defined by humans, and produce **Pass, Warn, or Block**. Human approval gates hold work until someone decides. Deterministic gates evaluate system-held facts such as labels, complexity, and required fields. Warnings persist as durable context on the ticket rather than disappearing. Status becomes derived rather than typed, and every advancement records which rule allowed or stopped it."
>
> **Proof.** A project defines: a human approval gate on Ready, a deterministic gate requiring complexity to be set, and a gate that blocks when a specific agent-set label is present. A ticket is stopped by each in turn and the reason is legible on the ticket. A Warn outcome is produced, does not stop the ticket, remains visible, and is consumed by a later gate's condition. Manual status override is possible but recorded as an override.
>
> **Depends on.** Phase 1 (objects), Phase 2 (agent-set labels and stage reports are the signals most gates evaluate). **Unblocks.** Budget gates, agentic gates, meaningful attention routing.

---

## 1. Objective and scope

Phase 3 turns observation into enforcement. The engine built here is reused three more times — budget gates plug into it in Phase 4, loop escalations in Phase 5, agentic rubrics in Phase 7 — so its extension points matter more than its initial rule set.

Three design commitments carry the phase:

1. **Warn is a first-class outcome, not a soft Block.** `VISION.md` §8.2 asks ambiguity checks to prefer Warn over silent Pass or hard Block. That only works if a warning is a durable object that later gates can query (D9). Most systems make warnings ephemeral toast; we make them rows.
2. **Gates never infer scope.** No gate reads a repository, parses a plan for file paths, or guesses blast radius. Agents set labels; gates read labels (`VISION.md` §6.3). This is permanent, not a PoC shortcut.
3. **One transition path.** Enforcement is inserted into the `transitionWorkItem` function Phase 1 built, not bolted onto the UI. If a stage change can happen without passing through gate evaluation, the system does not enforce anything.

### In scope

The condition DSL and its evaluator; the gate model and registry with deterministic and human evaluators; evaluation on transitions and on events; Pass/Warn/Block semantics; the warning lifecycle; approvals; completion of derived status; the policy configuration surface (after a forced UX decision); gate results on the ticket and blocked reasons on the board.

### Out of scope

| Not in Phase 3 | Lands in |
|---|---|
| LLM-evaluated gates | Phase 7 |
| Budget gates (the *type* is registered; the evaluator is a stub) | Phase 4 |
| Loop budget escalation gates | Phase 5 |
| Approvals appearing in a ranked inbox (they appear on the ticket and a simple list) | Phase 6 |
| Any gate inferring scope from a plan or repository | Never (`VISION.md` §3) |

---

## 2. Preconditions

- Phase 2 complete: reports, agent-set labels, and questions exist, since they are the signals most gates evaluate.
- A UX direction for policy configuration is decidable — step 3.7 forces it (`VISION.md` §17.1, Q13). The engine does not wait for it.
- Q12 answered or defaulted: who may override a gate.

---

## 3. Technical approach

### 3.1 Condition DSL

A versioned JSON AST (D11), evaluated in-process against a snapshot context. No expression strings, no `eval`, no rules-engine dependency.

```ts
// packages/contracts/src/conditions.ts
export type ConditionAst =
  | { op: 'and' | 'or'; of: ConditionAst[] }
  | { op: 'not'; of: ConditionAst }
  | { op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; field: FieldRef; value: Json }
  | { op: 'in' | 'not_in'; field: FieldRef; values: Json[] }
  | { op: 'has_label' | 'lacks_label'; value: string }        // exact key, or 'risk:*' prefix
  | { op: 'exists' | 'missing'; field: FieldRef }
  | { op: 'count_gte'; field: CountableRef; value: number };

export type FieldRef =
  | 'ticket.complexity' | 'ticket.stage.key' | 'ticket.owner_class' | 'ticket.title'
  | 'spec.exists' | 'spec.acceptance_criteria.count'
  | 'report.outcome' | 'report.confidence' | 'report.not_verified.count' | 'report.assumptions.count'
  | 'run.status' | 'run.count_in_stage'
  | 'warnings.open.count' | 'warnings.open_in_current_stage.count'
  | 'loop.count' | 'loop.count_from_stage'                     // P5
  | 'budget.item.spent_ratio' | 'budget.project.spent_ratio';  // P4
```

The context is built once per evaluation and is immutable, so every gate in a batch sees the same facts:

```ts
// packages/core/src/conditions/context.ts
export async function buildGateContext(ctx, workItemId): Promise<GateContext>;
// { ticket, labels, spec, latestReport, activeRun, warnings, loops, budget, project }
```

Every field is nullable and the evaluator has explicit null semantics — `missing` is true, comparisons against null are false, and `count_*` on an absent collection is zero. Null handling is where rule engines quietly produce nonsense, so it is specified in `docs/conditions.md` and unit-tested field by field.

The same DSL powers automation binding conditions, upgrading Phase 2's label-and-priority resolution to the full grammar.

### 3.2 Gates

```ts
type Gate = {
  id: string; projectId: string; name: string; description: string;
  evaluator: 'field_rule' | 'human_approval' | 'budget' | 'agentic';  // budget: P4, agentic: P7
  trigger:
    | { kind: 'on_transition'; fromStageId?: string; toStageId: string }
    | { kind: 'on_run_finished'; stageId?: string }
    | { kind: 'on_label_added'; labelKey: string }
    | { kind: 'on_demand' };
  appliesWhen: ConditionAst | null;      // gate is skipped entirely when false
  config: FieldRuleConfig | HumanApprovalConfig | BudgetConfig | AgenticConfig;
  onFailure: 'block' | 'warn';           // what a negative result means
  enabled: boolean;
  version: number;                        // bumped on every edit; evaluations record it
};

type FieldRuleConfig = { require: ConditionAst; warnWhen?: ConditionAst; message: string };
type HumanApprovalConfig = { approverRoles: Role[]; allowSelfApproval: boolean; instructions: string };
```

**Versioning is not optional.** Every evaluation stores `gate_version` and the resolved config, so "what rule fired, and what did it say at the time" survives later edits (`VISION.md` §8.4).

### 3.3 Evaluation

```ts
// packages/core/src/gates/evaluate.ts
export async function evaluateGates(ctx, {
  workItemId, trigger, dryRun = false,
}): Promise<GateBatchResult>;

type GateBatchResult = {
  outcome: 'pass' | 'warn' | 'block';        // worst wins: block > warn > pass
  results: GateResult[];                     // one per gate that applied
  blockedBy: GateResult[];
  warnings: WarningRef[];                    // created or reused
  contextSnapshot: GateContextSnapshot;      // stored for audit
};
```

Rules of the engine:

- **All applicable gates evaluate**, even after one blocks. A human seeing three problems at once fixes them in one pass; drip-feeding blocks is the fastest way to make people hate a gate system.
- **Worst outcome wins** for the transition decision, but every individual result is stored and shown.
- **Deterministic gates are pure and fast.** No I/O beyond the context snapshot, which is fetched once.
- **Human approval gates are asynchronous.** They return `block` with `reason: 'awaiting_approval'` and create (or reuse) a pending `approvals` row. Approving re-runs the batch; if nothing else blocks, the transition proceeds automatically.
- **Dry run is a first-class mode.** The UI uses it to show "what would happen if I moved this" before a person clicks, and the policy editor uses it to preview a rule against real items.

### 3.4 Warning lifecycle (D9)

A warning is created by a gate result and lives until resolved:

| Field | Meaning |
|---|---|
| `code` | Stable identifier from the gate (`spec.thin`, `risk.unlabelled`) — what conditions match on |
| `status` | `open` → `dismissed` (human judgement) or `resolved` (a later evaluation of the same gate passed) |
| `origin_stage_instance_id` | Where it came from, so "in current stage" queries work |
| `gate_evaluation_id` | Full provenance |

Auto-resolution: when a gate that previously warned evaluates to Pass on the same work item, its open warnings with that `code` are marked `resolved` with a pointer to the passing evaluation. Warnings never expire on stage exit — the Plan-stage warning informing a Review-stage gate is precisely the case the vision wants.

### 3.5 Derived status, completed

`deriveStatus` gains `pendingApprovals` and `blockingGateResults`, producing `needs_approval` and `blocked_by_gate`. With Phase 2's inputs already in place, the function now covers all of `VISION.md` §4.4's orthogonal states except `paused_budget` (Phase 4) and loop escalation (Phase 5). Manual override remains a recorded row that the derivation surfaces as an override, never as the underlying state.

### 3.6 Where policy configuration lives — decided in this phase

`VISION.md` §17.1 and `Implementation Phases.md` both demand this decision now. Step 3.7 timeboxes a prototype of both options and judges them against stated criteria rather than taste. The engine is indifferent: both prototypes call the same services.

---

## 4. Data model changes

```sql
-- 0010_gates.sql
create table gates (
  id uuid primary key,
  project_id uuid not null references projects(id),
  name text not null, description text not null default '',
  evaluator text not null check (evaluator in ('field_rule','human_approval','budget','agentic')),
  trigger jsonb not null,
  applies_when jsonb,
  config jsonb not null,
  on_failure text not null default 'block' check (on_failure in ('block','warn')),
  enabled boolean not null default true,
  version integer not null default 1,
  created_by_user_id uuid references users(id),
  archived_at timestamptz
);
create index gates_lookup on gates (project_id, enabled) where archived_at is null;

create table gate_evaluations (
  id uuid primary key,
  gate_id uuid not null references gates(id),
  gate_version integer not null,
  gate_config jsonb not null,                 -- resolved config at evaluation time
  work_item_id uuid not null references work_items(id),
  stage_instance_id uuid references stage_instances(id),
  trigger jsonb not null,
  outcome text not null check (outcome in ('pass','warn','block','skipped','error')),
  reason text not null,
  evidence jsonb not null default '{}',       -- which fields decided it
  context_snapshot jsonb not null,
  evaluator_meta jsonb not null default '{}', -- duration; model+tokens in P7
  batch_id uuid not null,                     -- groups one evaluateGates call
  created_at timestamptz not null default now()
);
create index gate_evals_item on gate_evaluations (work_item_id, created_at desc);

create table warnings (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  gate_id uuid references gates(id),
  gate_evaluation_id uuid references gate_evaluations(id),
  origin_stage_instance_id uuid references stage_instances(id),
  code text not null, message text not null,
  status text not null default 'open' check (status in ('open','dismissed','resolved')),
  resolved_by_evaluation_id uuid references gate_evaluations(id),
  dismissed_by_user_id uuid references users(id), dismissed_reason text, dismissed_at timestamptz,
  created_at timestamptz not null default now()
);
create index warnings_open on warnings (work_item_id) where status = 'open';

create table approvals (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  gate_id uuid not null references gates(id),
  gate_evaluation_id uuid not null references gate_evaluations(id),
  requested_at timestamptz not null default now(),
  requested_for jsonb not null,               -- the transition awaiting the decision
  status text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  decided_by_user_id uuid references users(id), decided_at timestamptz,
  comment text
);
create unique index approvals_one_pending on approvals (work_item_id, gate_id) where status = 'pending';

create table interventions (
  id uuid primary key,
  work_item_id uuid references work_items(id), project_id uuid not null references projects(id),
  kind text not null,      -- 'gate_override' | 'status_override' | 'warning_dismissed'
                           -- 'approval' | 'budget_raise' (P4) | 'run_killed' | 'answer' (P6)
  actor jsonb not null, target jsonb not null, detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
```

`interventions` starts here and accumulates through Phases 4–6. It is the raw material for Phase 9's "human touch count" and for the expansion backlog's pattern spotting, and it costs nothing to populate as we go.

`transitions.gate_evaluation_id` (nullable since Phase 1) is now populated with the batch that allowed the move.

---

## 5. Interfaces

### 5.1 Services

```ts
// packages/core/src/gates
createGate / updateGate / archiveGate(ctx, …): Result<Gate>       // bumps version on update
evaluateGates(ctx, { workItemId, trigger, dryRun }): Promise<GateBatchResult>
previewGate(ctx, { gate, workItemIds }): Promise<GatePreview[]>    // policy editor "what would this do"

// packages/core/src/warnings
listWarnings(ctx, workItemId, { status }): Warning[]
dismissWarning(ctx, id, reason): Result<Warning>                   // records an intervention

// packages/core/src/approvals
listPending(ctx, { projectId }): Approval[]
decide(ctx, approvalId, { decision, comment }): Result<Approval>   // re-runs the batch on approve
```

`transitionWorkItem` gains the enforcement path:

```ts
const batch = await evaluateGates(ctx, { workItemId, trigger: { kind: 'on_transition', toStageId } });
if (batch.outcome === 'block') return err({ kind: 'gate_blocked', results: batch.blockedBy });
// warn: proceed, warnings already persisted and attached
```

An override path exists for `owner`/`maintainer` (`transitionWorkItem(ctx, id, { …, override: { reason } })`), which records an `intervention` and stores `override: true` on the transition. Overrides are visible in history forever; that visibility is the control.

### 5.2 MCP additions

`get_gate_context` becomes real: recent gate results, open warnings with codes and messages, and pending approvals. Agents can now see why they were stopped and what would unblock them — which is what makes a remediation automation possible in Phase 7.

`get_ticket` gains a populated `warnings` array.

### 5.3 UI

- **Ticket:** a "Checks" panel listing each gate's latest result with outcome chip, reason, and evidence; open warnings with dismiss; pending approvals with approve/reject for permitted users; a "why can't I move this?" affordance driven by dry-run evaluation.
- **Board:** blocked cards carry a reason chip; hovering shows the blocking gate.
- **Policy configuration:** whichever surface step 3.7 selects.
- **Audit:** gate decisions appear in the event stream with their evidence.

---

## 6. Implementation steps

### Step 3.1 — Condition DSL and evaluator

**Goal.** A small, safe, well-specified expression language.

**Changes.** `packages/contracts/src/conditions.ts` (AST + zod, `{ v: 1 }` envelope); `packages/core/src/conditions/` evaluator and `buildGateContext`; `docs/conditions.md` documenting every field, its type, and its null behaviour; a `describeCondition()` renderer producing human-readable text ("complexity is set AND has no label risk:high") for the UI and for gate result reasons.

**Done when.** Unit tests cover every operator and every field including nulls; a fuzz test asserts the evaluator never throws on arbitrary valid ASTs; `describeCondition` round-trips in snapshot tests.

---

### Step 3.2 — Gate model, registry, evaluation engine

**Goal.** The engine, with two working evaluators and two registered stubs.

**Changes.** Gate CRUD with version bumping; the evaluator registry (`field_rule` and `human_approval` implemented; `budget` and `agentic` registered but returning `skipped` with a "not yet available" reason so Phase 4 and 7 are additive); `evaluateGates` with batching, worst-wins, snapshot persistence, and `dryRun`; event emission (`gate.evaluated`, `gate.blocked`, `gate.warned`).

**Done when.** A field-rule gate blocks and passes correctly against seeded items; evaluations are fully reconstructable from stored snapshots; evaluating 10 gates on one item takes a single context query.

---

### Step 3.3 — Enforcement at the transition, and on events

**Goal.** Gates actually stop things.

**Changes.** `transitionWorkItem` calls `evaluateGates` before mutating; `gate_blocked` error surfaced through UI and MCP; the override path with mandatory reason; event-triggered evaluation (`on_run_finished`, `on_label_added`) wired to Phase 2's events through job handlers so a report or label can immediately produce a warning or block.

**Done when.** A blocked transition returns a legible reason everywhere it can be attempted; an agent adding `risk:high` triggers an evaluation within one tick; an override is recorded and visible.

---

### Step 3.4 — Warnings

**Goal.** Warn behaves as first-class durable context.

**Changes.** Warning creation from `warn` results with de-duplication by `(work_item_id, gate_id, code)` while open; auto-resolution on a later pass; dismissal with reason plus intervention; `warnings.*` condition fields wired into the context so a later gate can consume them; ticket UI.

**Done when.** A warning produced at Plan is still open and visible at Review, and a Review gate configured as "block if `warnings.open.count >= 2`" fires correctly on the second warning.

---

### Step 3.5 — Human approval gates

**Goal.** Work waits for a person, and resumes when they decide.

**Changes.** Approval creation on evaluation; permission checks against `approverRoles` with `allowSelfApproval` honoured; approve/reject with comment; re-evaluation on approval that completes the original transition when nothing else blocks; withdrawal when the underlying context changes materially (for example the item moves elsewhere); a project-level pending approvals list as a stopgap surface before Phase 6.

**Done when.** A "Ready requires human Pass" gate holds the ticket in `needs_approval`, an authorised approval advances it automatically, a rejection holds it with the comment attached, and an unauthorised user cannot decide.

---

### Step 3.6 — Derived status completed

**Goal.** Status tells the truth without anyone typing it.

**Changes.** `deriveStatus` gains approvals and blocking gate results; the truth table extended and re-tested; the board and ticket render derived status everywhere; override UI requires a reason and shows a persistent "overridden" marker.

**Done when.** Every state in `VISION.md` §4.4 except budget and loop escalation is reachable and correct, and no code path writes a status string.

---

### Step 3.7 — Policy configuration: prototype both, then commit

**Goal.** Close `VISION.md` §17.1 with evidence. **Timebox: this step ships one surface, not two.**

**Prototypes** (both against the real engine, both behind flags, both using the same services):

- **A — Policy Studio:** `/projects/[key]/policies` with tabs for Gates, Bindings, Budgets (placeholder), and Optional concepts; a gate builder driven by `describeCondition`; a live preview showing which of the project's current items each gate would pass, warn, or block.
- **B — Board-embedded:** a per-stage configuration drawer opened from the board column header, holding the gates and bindings for that stage only.

**Judge on:** can a new user create a three-gate policy without help; does the board stay legible for a project with 12 gates; can a rule be previewed against real items; how many clicks to answer "why did this stop?"; how well does each accommodate Phase 4 budgets and Phase 7 rubrics without redesign.

**Recommendation to test first:** Studio. The board is a runtime view (`VISION.md` §8.5), and by Phase 7 there are five configurable concepts per project — a drawer will not hold them. Prototype B exists to prove or disprove that quickly, not as a formality.

**Done when.** The decision is recorded in `docs/decisions/ADR-0009-policy-surface.md` with the evidence used (design analysis against the five criteria; no board-drawer prototype was built), and the winner (Policy Studio) is complete for gates and bindings.

---

### Step 3.8 — Surfacing enforcement

**Goal.** Enforcement is legible to someone who did not configure it.

**Changes.** Ticket Checks panel; blocked chips on the board with reasons; "why can't I move this?" using dry-run evaluation, listing every failing gate at once; gate decisions in the audit view with evidence; empty states that explain what a gate would do rather than showing nothing.

**Done when.** A person who has never seen the project can explain, from the ticket alone, why it is stopped and what would unblock it.

---

### Step 3.9 — Hardening and flag removal

**Changes.** Guard against pathological configurations (a cap on gates per project; rejection of conditions deeper than 8 levels; a warning when two gates on the same trigger contradict each other); an index review for `gate_evaluations`; a retention policy for context snapshots (keep 90 days at full fidelity, then trim to evidence only); runbook section "a ticket is stuck and nobody knows why".

**Done when.** The flags are gone and a project with 20 gates evaluates a transition in under 150 ms server time.

---

## 7. Testing and verification

- **Unit.** Every operator and field of the DSL including null semantics; worst-wins outcome selection; warning de-duplication and auto-resolution; approval permission logic; `deriveStatus` truth table (now materially larger).
- **Integration.** Blocked transitions do not mutate state (assert the stage instance is untouched); approval → automatic completion of the original transition; event-triggered evaluation from a Phase 2 report; overrides recording interventions; gate edits not retroactively changing stored evaluations.
- **Scenario tests** mirroring the demo: three gate types, one Warn consumed by a later gate, one override.
- **Property test.** For random gate sets and random items, the batch outcome always equals the worst individual outcome, and no gate is evaluated twice in a batch.
- **Performance.** 20 gates × 200 items dry-run preview completes within the policy editor's interaction budget.

## 8. Rollout and safety

- Flag `p3.gates`, per project. Until enabled, transitions behave exactly as in Phase 1 — this is the escape hatch if enforcement misfires mid-demo.
- New gates are created **disabled** by default with a preview of their effect on current items; enabling is a deliberate second action.
- A project-level `enforcement_mode ∈ {enforce, observe}`: in `observe`, gates evaluate and record but never block. Useful for introducing gates to a live project and for debugging a rule that fires unexpectedly.
- Overrides always work for `owner`/`maintainer`, so a bad rule cannot permanently trap work.

## 9. Demo script (the proof)

1. **Define three gates** in project Alpha: (a) human approval on the transition into Implementation; (b) field rule requiring complexity to be set before leaving Scoping; (c) block when the label `risk:high` is present on the transition into Deploy.
2. **Stopped by (b).** Create an item with no complexity, try to leave Scoping, get blocked with a legible reason. Set complexity; the same move succeeds.
3. **Stopped by (a).** Move toward Implementation: the ticket reads `Needs approval`. Approve as a maintainer; the transition completes automatically with the approval recorded.
4. **Stopped by (c) — set by an agent.** Run the Phase 2 automation, which sets `risk:high` from its report. Attempt Deploy: blocked, with the reason pointing at the label and the report that set it.
5. **Warn.** A gate configured with `on_failure: 'warn'` produces "spec has no acceptance criteria and low confidence". The ticket moves on; the warning stays visible.
6. **Warn consumed.** A later gate on Deploy is configured to block when `warnings.open.count >= 1`; show it firing, referencing the warning raised two stages earlier.
7. **Override.** A maintainer overrides with a reason; the transition succeeds and the ticket carries a permanent "overridden" marker with who and why.
8. **Configuration surface.** Walk the chosen policy surface; edit a gate; show that a stored evaluation still reflects the old version.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| The DSL grows into a programming language | Requests for arithmetic, regex, string manipulation | The field list is a closed enum; new fields need a PR and a test. Say no in review, not in the parser |
| Gate soup — nobody knows why anything is blocked | "Why is this stuck?" asked more than once a week | All gates evaluate every time; the ticket shows every failing check at once with evidence |
| Configuration UI collapses under Phase 7's additions | The drawer needs a scrollbar in the prototype | Step 3.7's judging criteria explicitly include accommodating budgets and rubrics |
| Gate edits appear to rewrite history | An old evaluation reads differently after a config change | Version and config are copied into every evaluation row; tested explicitly |
| Enforcement blocks the Phase 4 demo | Budget work stalls behind a misfiring gate | `enforcement_mode: observe` and the per-project flag |
| Warnings accumulate into noise | Dozens of open warnings on a normal ticket | Dismissal is one click with a reason; the ticket groups by code; Phase 9 reports warning volume per gate so bad gates get found |
| Approval deadlock | An approval sits pending with no eligible approver | Validate at gate-creation time that the project has at least one member in each `approverRoles`; surface stale approvals after 48 hours |

## 11. Exit criteria

- [x] Gates are defined per project, in the database, by humans, with no repository involvement.
- [x] Deterministic and human approval evaluators both work; budget and agentic types are registered stubs.
- [x] Pass, Warn, and Block all behave per `VISION.md` §8.2, and Warn is durable.
- [x] A warning raised in one stage is consumed by a gate in a later stage.
- [x] Every transition records the evaluation batch that allowed or stopped it, with the gate version and config in force.
- [x] Status is fully derived; overrides are recorded as interventions.
- [x] The policy configuration decision is made, recorded, and implemented (Policy Studio). No competing board-drawer prototype was built — see ADR-0009.
- [x] `get_gate_context` returns real data to agents.
- [x] A blocked ticket explains itself without a person reading the database.

## 12. Open questions for this phase

- **Q13** — Policy Studio versus board-embedded. Forced closed by step 3.7; an early product steer would save the prototype timebox.
- **Q12** — who may override a gate. Default: `owner`/`maintainer`, always recorded.
- **Local:** should a Block on `on_run_finished` be able to *cancel* the run that produced it? Recommendation: no in Phase 3 — the run is already finished; Phase 7's remediation routing is the right place for corrective action.
- **Local:** do gates apply to overrides of a *previous* gate (re-evaluation cascades)? Recommendation: no cascade; an override applies to one transition only and never disables gates for later moves.

---

## 13. Deviations recorded during implementation (2026-07-27)

- **ADR number.** Plan said `ADR-0008-policy-surface.md`; `ADR-0008-design-system.md` already existed, so the decision is `ADR-0009-policy-surface.md` (called out in the ADR).
- **Policy surface.** Chose Policy Studio via design analysis against the five criteria (ADR-0009). A board-embedded drawer prototype was **not** built; earlier wording that claimed it was prototyped and deleted was incorrect and has been corrected.
- **Stage keys in demo.** Default template has `intake → scoping → plan → implementation → review → deploy` (no literal "Ready" stage). Demo gates map approval → Implementation, complexity → leaving Scoping into Plan, risk label → Deploy.
- **Flag removal.** Step 3.9 title says "flag removal"; section 8 requires keeping `p3.gates`. Kept the rollout flag; no A/B prototype flags were shipped.
- **`blocked_by_gate` status.** Added to `DerivedStatus` enum (was missing from Phase 1/2 contracts); `pendingApprovals` → `needs_approval`, other blocking gate results → `blocked_by_gate`.
- **Bindings DSL.** Phase 2 legacy `{ labelKeysAny, … }` still accepted. `{ v: 1, ast }` envelopes are accepted only when the envelope branch of `BindingConditionSchema` is matched first (fixed in rework — previously the all-optional legacy object stripped envelopes to `{}`).
- **Snapshot retention.** Documented 90-day policy in runbook; automated trim job not shipped (index `gate_evals_created` ready for it).
- **Job handlers for gates.** `gate_on_run_finished` / `gate_on_label_added` handlers were removed as dead code; evaluation runs inline from `closeOutRun` / `setLabels` with logged failures (core cannot depend on `@nexus/jobs` without a cycle).
- **Owner as implicit approver.** Exact `approverRoles` membership (not rank) forbids a maintainer-only list from elevating every higher role, but **owner** may always decide approvals — owners can already override gates, so excluding them is theatre. Recorded in ADR-0009.
- **Warning lifecycle.** Dismissal suppresses re-raise for the same `(item, gate, code)` until the gate next **passes** (which resolves open and dismissed rows). A later failure then raises a fresh warning. Documented in `docs/conditions.md`.
- **Stale approvals.** Listing surfaces a `stale` flag after 48h; it does not auto-withdraw on SSR. Decisions remain allowed on stale rows until a future background sweep.
- **Migration numbering.** No `0011_*` in this branch — Phase 4 owns it; noted in `0012_gates_rls.sql`.
