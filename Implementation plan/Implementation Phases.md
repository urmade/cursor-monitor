# Implementation Phases — Agentic Project Control Plane (PoC)

Companion to `VISION.md`. This document defines **phases by outcome**, their **dependencies**, and **how we prove each one is done**. It deliberately contains no technical design: each phase will be broken into implementation steps separately.

---

## How to read this

Each phase states:

- **Outcome** — what becomes true when the phase is complete.
- **Proof** — the demo that closes the phase. If we can't demo it, it isn't done.
- **Depends on** — what must exist first.
- **Unblocks** — what becomes possible.
- **Not yet** — explicitly deferred, to prevent scope creep into the phase.

Two structural notes that matter more than the phase order itself:

1. **Some surfaces accrete across phases** rather than being built once (see §Accreting surfaces). The attention inbox and the ticket detail page each gain sources phase by phase. Planning them as single-phase deliverables is the main way this plan could go wrong.
2. **We depend on companion Cursor Automations we do not own.** The system orchestrates automations; it does not create them. Someone must hand-author test automations (scoping, plan, implementation) that talk to our MCP server, or Phase 2 onward cannot be demonstrated. This is the most commonly underestimated dependency in the plan.

---

## Milestones

| Milestone | Achieved after | What it means |
|---|---|---|
| **M1 — Loop proven** | Phase 0 | We know the Cursor orchestration model works and the big unknowns are closed |
| **M2 — Usable** | Phase 2 | A team can run real agentic work through the system and see it tracked and audited |
| **M3 — Governed** | Phase 4 | The system enforces process and controls spend; work can be safely left running |
| **M4 — Product** | Phase 6 | Humans live in the inbox rather than the board; the value proposition is visible |
| **M5 — PoC complete** | Phase 9 | All §16 success criteria in `VISION.md` demonstrated |

---

## Phase 0 — De-risk and decide

**Outcome.** The unknowns that could invalidate the architecture are closed with evidence rather than assumption. We know how we start a Cursor Automation, how we observe it, how the agent reaches back to us, and what our identity and access model is. A throwaway walking skeleton exists end to end with no UI and no persistence beyond the minimum.

**Proof.** A hardcoded ticket identifier triggers a real Cursor Automation in a real repository; the automation reaches our MCP endpoint, reads something, writes something back; we observe the run reaching a terminal state and record its duration and token usage. Demonstrated live, twice, including one failure case.

**Depends on.**
- A Cursor organization with an appropriate plan tier and a service account.
- At least one hand-authored Cursor Automation to invoke.
- A publicly reachable MCP endpoint, and network egress permission from Cursor cloud agents to reach it.
- Answers recorded for the open decisions in `VISION.md` §17 items 2, 3 and 7 (invoke path, agentic-gate execution location, auth model).

**Unblocks.** Everything. No other phase should start before the invoke-and-observe path is proven.

**Not yet.** Persistence, UI, gates, cost, multiple projects.

**Risk note.** This is the highest-risk phase in the plan. Cursor's event surface is thinner than its API surface, per-run attribution has known quirks, and only one run can be active per agent. If any of these force a different orchestration shape, we want to know here and not in Phase 4.

---

## Phase 1 — System of record

**Outcome.** Projects, work items, complexity, labels, stages, and specs exist and persist. A human can use the system as a plain tracker with no agents involved: create a project with its own pipeline and label taxonomy, create tickets, set complexity, move tickets through stages, and see a complete history of what changed and who changed it.

**Proof.** Two projects with different pipelines and different label taxonomies coexist. A ticket is created, specced by hand, moved through every stage to Deploy, and its full transition history is auditable. Nothing is hardcoded to a single project shape.

**Depends on.** Phase 0 decisions on the shape of core objects. Nothing external.

**Unblocks.** Every subsequent phase — all of them reference these objects.

**Not yet.** Agent involvement, gates, cost, attention routing. Stage movement is manual and unguarded in this phase, and that is fine.

---

## Phase 2 — The agent loop

**Outcome.** The system can put agentic work in motion and account for it. A stage can be bound to an existing Cursor Automation; the system starts that automation passing only a ticket identifier; the agent fetches the spec and ticket context through MCP, writes results back as a structured stage report, sets labels, and can raise a blocking question; the system records the run with its status, duration, token usage, and outcome, and links out to the run in Cursor.

This is the heart of the product. After this phase the system does something no existing tracker does.

**Proof.** A one-line ticket enters Intake. The bound scoping automation runs, writes a real spec into our database, and posts a stage report with labels. The ticket detail page shows the report at headline level, expandable, with the run's duration and token usage and a working link to Cursor. A second run on the same ticket appends rather than overwrites. One run is deliberately failed and shows as a failed run rather than a silently stuck ticket.

**Depends on.**
- Phase 0 (proven invoke and observe path) and Phase 1 (objects to attach runs to).
- **Companion automations authored outside this system** for at least the scoping stage.
- Agreement on the minimum stage-report content, since gates in Phase 3 consume it.

**Unblocks.** Gates (they evaluate reports and labels), cost control (it needs run data), loops (they need stage instances), attention (it needs questions and failures).

**Not yet.** Enforcement of any kind. Runs can be started even when they shouldn't be. Questions are captured and make the ticket visibly blocked, but there is no ranked inbox yet.

**Dependency note.** The MCP surface is load-bearing: nearly every later phase assumes agents can read and write through it. Treat its contract as the most stable thing we own, and change it reluctantly after this phase.

---

## Phase 3 — Process enforcement

**Outcome.** The system enforces the process a team defines. Gates exist per project, are defined by humans, and produce **Pass, Warn, or Block**. Human approval gates hold work until someone decides. Deterministic gates evaluate system-held facts such as labels, complexity, and required fields. Warnings persist as durable context on the ticket rather than disappearing. Status becomes derived rather than typed, and every advancement records which rule allowed or stopped it.

**Proof.** A project defines: a human approval gate on Ready, a deterministic gate requiring complexity to be set, and a gate that blocks when a specific agent-set label is present. A ticket is stopped by each in turn and the reason is legible on the ticket. A Warn outcome is produced, does not stop the ticket, remains visible, and is consumed by a later gate's condition. Manual status override is possible but recorded as an override.

**Depends on.** Phase 1 (objects), Phase 2 (agent-set labels and stage reports are the signals most gates evaluate). A UX direction for where policies are configured — this is `VISION.md` §17 item 1 and it blocks the configuration surface, not the engine.

**Unblocks.** Budget gates, agentic gates, meaningful attention routing (approvals become inbox items).

**Not yet.** LLM-evaluated gates. Budget-based gates. Any gate that infers scope from a plan or from repository contents — permanently out, by design.

**Decision to force in this phase.** Policy Studio as a dedicated per-project surface, versus policy controls embedded in the pipeline board. Prototype both far enough to judge overload, then commit. The engine should not care which we choose.

---

## Phase 4 — Economics

**Outcome.** Work has a price and a ceiling. Costs roll up from run to stage to work item to project. Complexity tiers carry default budgets that apply automatically. A project has a burn budget that blocks further work when crossed. Budget gates warn at a soft threshold and block at a hard one, and a human can raise a cap or pause work deliberately.

**Proof.** A high-complexity ticket inherits its budget automatically, crosses its soft threshold and shows a warning, then crosses its hard threshold and is blocked mid-pipeline. A project burn cap blocks a second ticket that would otherwise have started. A human raises the cap and work resumes, with both the block and the override audited. Costs shown as estimates are visibly labelled as estimates.

**Depends on.** Phase 2 (run-level usage data) and Phase 3 (the gate engine budget gates plug into). A token-to-currency price table. Clarity on whether the customer's Cursor plan tier exposes reconciled charges — if it does not, we ship estimates only and say so in the UI.

**Unblocks.** Historical cost estimation in Phase 8. Safe unattended operation, which is what makes M3 meaningful.

**Not yet.** Predictive estimates for new tickets. Cross-project spend analytics.

---

## Phase 5 — Loops and rework

**Outcome.** Backward movement is a first-class, visible fact rather than an absence of progress. Every return to an earlier stage is recorded with a reason code and a trigger. A ticket shows how many times it has looped, between which stages, and what that looping has cost in time and money. A project can set a loop budget that warns or escalates when a ticket cycles too often.

**Proof.** A ticket is sent back from a review-like stage to implementation twice. The ticket shows a loop count, the two return edges with their reasons, and the cumulative cost of the looping. A loop budget triggers an escalation on the third return.

**Depends on.** Phase 1 (transitions), Phase 2 (stage instances), Phase 4 (cost attribution to make loop cost meaningful). Independent of Phase 6 and can be built in parallel with it.

**Unblocks.** Loop escalations as an attention source. The rework metrics in Phase 8.

**Not yet.** Loop hotspot analytics across projects. Automatic strategy changes in response to looping.

---

## Phase 6 — Attention

**Outcome.** The inbox becomes the product's home, and humans stop scanning the board. Everything needing a person is ranked in one place, each row explains why it is there and what decision is being asked, and each row can be acted on without opening the ticket. Answering a blocking question resumes the work by triggering the appropriate automation. Notifications reach people outside the app.

**Proof.** With several tickets in flight, the inbox shows exactly the items needing a human — blocking questions, pending approvals, budget blocks, failed runs, loop escalations — correctly ranked, each self-explaining. A question is answered from the inbox and the work resumes without anyone touching a stage field. Everything else is visibly and unambiguously "AI working, nothing needed from you."

**Depends on.** All of its sources: Phase 2 (questions, failed runs), Phase 3 (approvals, warnings), Phase 4 (budget blocks), Phase 5 (loop escalations). This is why it lands here rather than earlier, even though it is the most valuable surface.

**Unblocks.** M4. This is the phase where the product's thesis becomes visible to a user.

**Not yet.** Batch processing of many decisions at once, per-person ranking preferences, digests. Those are Phase 9 polish if they earn it.

---

## Phase 7 — Judgment assist

**Outcome.** The system can evaluate quality itself, and teams can opt into the process concepts they actually want. Agentic gates assess a spec or a stage report against a human-authored rubric and return Pass, Warn, or Block — preferring Warn under uncertainty. When an agentic gate concludes that a rewrite is needed, the remediation is performed by a bound Cursor Automation, never by an agent loop inside our product. Separately, acceptance criteria and visual confirmation become per-project opt-in concepts rather than imposed requirements.

**Proof.** A project defines a rubric asking whether a spec has testable outcomes. A deliberately vague spec is caught: Block on one variant, Warn on a borderline one, with the warning readable and reusable as context by a later gate. The Block routes to a bound rewrite automation, which produces a revised spec that then passes. Separately, one project runs with acceptance criteria enabled and another with them off, and neither is nagged about the other's concepts.

**Depends on.** Phase 3 (the gate engine), Phase 2 (specs and reports to evaluate). A settled decision on where agentic gate evaluation executes (`VISION.md` §17 item 3). Phase 6 helps but is not strictly required.

**Unblocks.** Most of the perceived intelligence of the system. Also the honest measurement of gate quality in Phase 8.

**Not yet.** Learned rubrics, self-tuning thresholds, spec templates derived from history.

---

## Phase 8 — Openness

**Outcome.** The system is as operable by machines as by people. Outbound events for ticket, stage, run, gate, and question activity are published reliably with visibility into delivery. A public interface covers the core objects so external tooling can read and drive the system.

**Proof.** An external endpoint receives events for a full ticket lifecycle. A deliberately failing endpoint shows failed deliveries with their reasons and can be replayed after being fixed. An external script creates a ticket, sets complexity, and reads its state through to Deploy.

**Depends on.** Phases 1 through 5 for the events worth publishing. Otherwise independent — this can run in parallel with Phases 5 through 7 and is the most parallelizable phase in the plan.

**Unblocks.** Any adjacent tooling, and later third-party sync from the expansion backlog.

**Not yet.** Third-party project management sync of any kind.

---

## Phase 9 — Estimation, insight, and PoC exit

**Outcome.** The system predicts before it spends, reports on itself, and passes its own acceptance test. New tickets show a cost range derived from complexity, labels, project, and historical spend, with an honest cold-start behaviour before enough history exists. Thin analytics report cost per item, spend against budget, rework rate, and gate Pass/Warn/Block rates. Access control is complete enough for real use, and every §16 success criterion in `VISION.md` is demonstrated end to end.

**Proof.** The eight success criteria in `VISION.md` §16 are walked through in one sitting on a clean environment. A new ticket shows a plausible cost range that a retrospective check confirms against actuals. A project with too little history shows the complexity default and says so rather than inventing a number.

**Depends on.** Phase 4 (cost history is the input), Phase 5 (rework rate), Phase 7 (gate outcome rates), and all prior phases for the acceptance walkthrough. Agreement on the minimum history required before ranges are shown (`VISION.md` §17 item 5).

**Unblocks.** The go/no-go decision on the expansion backlog.

**Not yet.** Trust indices, model comparisons, per-scope autonomy, intervention-to-rule measurement.

---

## Accreting surfaces

These are built incrementally and should be planned as such. Each cell is what the phase adds.

| Surface | P1 | P2 | P3 | P4 | P5 | P6 | P7 |
|---|---|---|---|---|---|---|---|
| **Ticket detail** | Spec, stage, labels, history | Stage reports, runs, questions | Gate results, warnings | Cost and budget | Loops and loop cost | — | Rubric outcomes |
| **Attention list → Inbox** | — | Blocked and failed items appear | Approvals appear | Budget blocks appear | Loop escalations appear | Becomes ranked, explained, actionable | — |
| **Board** | Stages and tickets | AI-working state | Blocked reasons | Budget state | Loop badges | Attention swimlanes | — |
| **Project config** | Pipeline, labels | Automation bindings | Gates and policies | Budgets and burn cap | Loop budget | — | Optional concepts, rubrics |
| **Audit** | Transitions | Runs | Gate decisions | Budget events and overrides | Return edges | Human actions | Rubric verdicts |

---

## Dependency map

```
P0 De-risk
 └─> P1 System of record
      └─> P2 Agent loop  ── requires companion Cursor Automations (external)
           ├─> P3 Enforcement
           │    ├─> P4 Economics
           │    │    ├─> P5 Loops ─┐
           │    │    └─────────────┼─> P6 Attention
           │    └─> P7 Judgment ───┘
           └─> P8 Openness  (parallel from here on)
                              └─> P9 Estimation & exit  (needs P4, P5, P7)
```

Parallelisation opportunities, once Phase 3 is complete: Phase 8 runs independently throughout; Phase 5 and Phase 7 do not depend on each other; the Policy Studio UX exploration can begin during Phase 2.

---

## External dependencies register

| Dependency | Needed by | Consequence if late |
|---|---|---|
| Cursor org, plan tier, service account | P0 | Nothing starts |
| Hand-authored companion Automations | P2 | No phase past P1 can be demoed |
| Public MCP endpoint reachable from Cursor cloud agents | P0 | Agents cannot fetch context; core model unproven |
| Network egress permission for customer environments | P0, and again at pilot | Works in our org, fails in theirs |
| Token-to-currency price table | P4 | No cost figures at all |
| Plan tier that exposes reconciled charges | P4 | Estimates only; must be labelled honestly in UI |
| Policy configuration UX decision | P3 | Engine can proceed; configuration surface cannot |
| Access control model | P3, hardened in P9 | Gates and budgets are unenforceable in practice |

---

## Traceability

**Vision features to phases**

| Feature | Phase |
|---|---|
| F1 Projects, WorkItems, derived state | P1, derived state completed in P3 |
| F2 Specs and scoping via Automations | P2, ambiguity warnings in P7 |
| F3 Stages, labels, board | P1, board matures P3–P6 |
| F4 Automation orchestration and run audit | P2 |
| F5 Structured stage reports and ticket UI | P2 |
| F6 Gates and Policy Studio | P3, agentic gates P7 |
| F7 Attention inbox | P6, sources from P2–P5 |
| F8 Questions protocol | Capture P2, routing and resume P6 |
| F9 Cost, time, estimates | Tracking P4, estimation P9 |
| F10 Loops and rework | P5 |
| F11 Webhooks, API, MCP | MCP in P2, webhooks and API in P8 |
| F12 Cursor integration | P0 and P2 |
| F13 Analytics | P9 |

**Success criteria to phases**

| §16 criterion | Proven in |
|---|---|
| 1. Project with stages, labels, complexity budgets, burn cap | P1 and P4 |
| 2. Gates including human and agentic Pass/Warn/Block | P3 and P7 |
| 3. Bind existing Automations, run with ticket ID, audited with time and cost | P2 and P4 |
| 4. Agents fetch and update spec via MCP, set labels honoured by gates | P2 and P3 |
| 5. Inbox for answering and approving without manual status updates | P6 |
| 6. Loops visible when work returns to earlier stages | P5 |
| 7. Deploy as terminal stage | P1 |
| 8. Cost range estimate from complexity and history | P9 |

---

## Sequencing principles

1. **Nothing is built on an unproven integration.** Phase 0 exists because the orchestration model is the only part of this that can fail architecturally.
2. **Each phase ends in a demo, not a merge.** If a phase cannot be shown to someone outside the team, it is not finished.
3. **Enforcement follows observation.** We track before we block. A system that blocks based on signals it cannot yet see reliably will be turned off by its users.
4. **The inbox is earned, not built early.** It is only credible once it has real sources; a thin version that misses things is worse than a board.
5. **Cost control precedes autonomy.** No phase should encourage leaving work running unattended before Phase 4 is complete.
6. **The MCP contract is the most expensive thing to change.** Settle it in Phase 2 and treat it as stable thereafter.
