# ADR-0009: Policy configuration surface

**Status.** Accepted (Phase 3 step 3.7)  
**Date.** 2026-07-27  
**Note.** `ADR-0008-design-system.md` already exists; this decision takes the next free number.  
**Honesty revision.** 2026-07-27 — earlier draft claimed a board-embedded drawer prototype was built and deleted. That claim was unsupported by git history. This revision records what actually happened: a design analysis against the plan's criteria, carrying forward the plan's prediction without an implemented Prototype B.

## Context

`VISION.md` §17.1 / §8.5 and Phase 3 step 3.7 require choosing where humans configure gates (and later budgets, bindings, rubrics):

- **A — Policy Studio:** `/projects/[key]/policies` with tabs for Gates, Bindings, Budgets (placeholder), Approvals.
- **B — Board-embedded:** a per-stage drawer from the board column header holding gates/bindings for that stage only.

Both options would call the same `createGate` / `previewGate` / `listGates` services; only the chrome differs.

## Decision criteria (from the phase plan)

1. Can a new user create a three-gate policy without help?
2. Does the board stay legible for a project with 12 gates?
3. Can a rule be previewed against real items?
4. How many clicks to answer "why did this stop?"
5. How well does each accommodate Phase 4 budgets and Phase 7 rubrics without redesign?

## Analysis (no board-drawer prototype was shipped)

Prototype A (Policy Studio) was implemented and is what shipped. Prototype B was **not** implemented in this repository — there is no drawer component, no A/B flag, and no deleted drawer commits. The comparison below is a design analysis against the five criteria, using the plan's own prediction for B rather than observations from a built drawer.

| Criterion | Studio (A) — observed | Board drawer (B) — predicted |
|---|---|---|
| Three-gate policy | One form on Gates tab; create → preview → enable works in Studio | Would require opening three columns; cross-stage gates awkward |
| Board legibility @ 12 gates | Board unchanged (runtime-only chips) | Column headers would sprout badges + drawer chrome |
| Preview against real items | Built into Studio gate cards (`previewGate`) | Preview would be cramped inside a drawer |
| "Why did this stop?" | Ticket Checks panel (separate from config) | Mixing config + runtime on the board blurs the question |
| Phase 4/7 growth | Budgets + Rubrics tabs already scaffolded | Drawer unlikely to hold five concepts per stage |

## Decision

**Ship Policy Studio (A).** Do not build a board-embedded configuration drawer.

The board remains a runtime view (`VISION.md` §8.5). Ticket Checks + dry-run answer "why stopped?"; Studio answers "what rules exist?". The plan recommended testing Studio first; analysis of the five criteria agreed, so B was not built.

## Consequences

- Nav gains a **Policies** tab per project.
- Settings keeps launch/binding edit details; Studio lists bindings for orientation.
- No board-embedded drawer code exists (and none was deleted — none was written).
- Q13 in `open-questions.md` is closed.

## Related decision: who may decide approvals (2026-07-27 rework)

`approverRoles` uses **exact role membership**, not rank — so `approverRoles: ['viewer']` does not make every higher role an approver (architecture-baseline §6.3).

**Exception:** `owner` is always an implicit approver, even when not listed. Owners can already `gate.override`, so denying them `approval.decide` on a maintainer-only gate is theatre and creates a dead end if a project later loses its last listed maintainer. Self-approval rules still apply to owners when `allowSelfApproval: false`.
