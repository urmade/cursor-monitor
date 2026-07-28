# Phase implementation plans

Technical implementation plans for the Agentic Project Control Plane (working name: **Nexus**, after the Vercel project name `nexus`).

These documents sit one level below the two planning documents in the parent folder:

| Document | Answers |
|---|---|
| [`../VISION.md`](../VISION.md) | *What* the product is and what is in and out of PoC scope |
| [`../Implementation Phases.md`](../Implementation%20Phases.md) | *In what order* outcomes are delivered and how each is proven |
| **This folder** | *How* each phase is built: architecture, schema, interfaces, ordered steps, tests, demo |

Nothing here changes scope. Where a technical decision was needed that the vision left open, it is recorded in [`decisions.md`](./decisions.md) with rationale and reversal cost; where a decision needs a human, it is in [`open-questions.md`](./open-questions.md).

---

## Read in this order

1. [`architecture-baseline.md`](./architecture-baseline.md) — the platform constraints we inherit from internalsphere, the monorepo layout, and the conventions every phase assumes. Read this first; the phase plans do not repeat it.
2. [`decisions.md`](./decisions.md) — the standing technical decisions (D1–D18), including the verified facts about the Cursor APIs that the orchestration model depends on.
3. The phase you are working on.

## Phase plans

| Phase | Plan | Milestone | Depends on |
|---|---|---|---|
| 0 — De-risk and decide | [`phase-00-de-risk-and-decide.md`](./phase-00-de-risk-and-decide.md) | M1 Loop proven | Cursor org access |
| 1 — System of record | [`phase-01-system-of-record.md`](./phase-01-system-of-record.md) | — | P0 |
| 2 — The agent loop | [`phase-02-agent-loop.md`](./phase-02-agent-loop.md) | M2 Usable | P0, P1, companion automations |
| 3 — Process enforcement | [`phase-03-process-enforcement.md`](./phase-03-process-enforcement.md) | — | P1, P2 |
| 4 — Economics | [`phase-04-economics.md`](./phase-04-economics.md) | M3 Governed | P2, P3 |
| 5 — Loops and rework | [`phase-05-loops-and-rework.md`](./phase-05-loops-and-rework.md) | — | P1, P2, P4 |
| 6 — Attention | [`phase-06-attention.md`](./phase-06-attention.md) | M4 Product | P2–P5 |
| 7 — Judgment assist | [`phase-07-judgment-assist.md`](./phase-07-judgment-assist.md) | — | P2, P3 |
| 8 — Openness | [`phase-08-openness.md`](./phase-08-openness.md) | — | P1–P5 (parallelisable) | Done (PR #21) |
| 9 — Estimation, insight, PoC exit | [`phase-09-estimation-insight-and-poc-exit.md`](./phase-09-estimation-insight-and-poc-exit.md) | M5 PoC complete | P4, P5, P7 |

## How each plan is structured

Every phase document uses the same shape so they can be diffed, reviewed, and picked up mid-flight:

| Section | Contains |
|---|---|
| Header block | Outcome (quoted from `Implementation Phases.md`), dependencies, milestone |
| 1. Objective and scope | What this phase makes true; explicit non-goals with the phase they land in instead |
| 2. Preconditions | What must be true before step 1 starts, including external dependencies |
| 3. Technical approach | The design for this phase and the decisions it applies |
| 4. Data model changes | Migration-by-migration DDL sketch |
| 5. Interfaces | API, MCP, and UI contracts introduced or changed |
| 6. Implementation steps | The tangible, ordered increments — each with files touched, key code, and a "done when" |
| 7. Testing and verification | Unit, integration, contract, and preview-environment checks |
| 8. Rollout and safety | Feature flags, migration safety, what happens if the phase ships half-finished |
| 9. Demo script | The literal walkthrough that closes the phase |
| 10. Risks and mitigations | Ranked, with the trigger that tells you the risk is materialising |
| 11. Exit criteria | Checklist; the phase is not done until every box is ticked |
| 12. Open questions | Scoped to this phase, cross-referenced to `open-questions.md` |

### Conventions that apply to every phase

- **A step is a mergeable PR.** Each numbered step in section 6 should be a PR that deploys green to preview and leaves `main` releasable. Steps are ordered so that a phase can be paused between any two of them.
- **Every merge is a production deploy.** `main` deploys automatically, so unfinished work ships behind a feature flag (see `architecture-baseline.md` §9).
- **A phase ends in a demo, not a merge.** Section 9 of each plan is the acceptance test. If it cannot be walked through live, the phase is open.
- **Migrations are forward-only and expand/contract.** No migration may break the currently deployed application version — CI runs migrations *before* the new code is live.
- **Contracts are versioned, code is not precious.** The MCP contract (Phase 2) and the event catalogue (Phase 1, exposed in Phase 8) are the two surfaces we promise stability on.

## Status

| Phase | Status |
|---|---|
| 0 — De-risk and decide | Done (see `docs/decisions/phase-0-report.md`) |
| 1 — System of record | Done |
| 2 — The agent loop | Done |
| 3 — Process enforcement | Done |
| 4 — Economics | Done |
| 5 — Loops and rework | Done |
| 6 — Attention | Done |
| 7 — Judgment assist | Done |
| 8 — Openness | Done (PR #21; now on main) |
| 9 — Estimation, insight, PoC exit | Done (this PR — M5) |

Update this table as phases move to In progress / Done, and record deviations in the phase document rather than in a separate changelog — the plan is the living document.
