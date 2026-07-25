# Implementation Phases — Agentic Project Control Plane (PoC)
Companion to `VISION.md`. This document defines **phases by outcome**, their **depende
ncies**, and **how we prove each one is done**. It deliberately contains no technical
design: each phase will be broken into implementation steps separately.
---
## How to read this
Each phase states:
- **Outcome** — what becomes true when the phase is complete.
- **Proof** — the demo that closes the phase. If we can't demo it, it isn't done.
- **Depends on** — what must exist first.
- **Unblocks** — what becomes possible.
- **Not yet** — explicitly deferred, to prevent scope creep into the phase.
Two structural notes that matter more than the phase order itself:
1. **Some surfaces accrete across phases** rather than being built once (see §Accretin
g surfaces). The attention inbox and the ticket detail page each gain sources phase by
 phase. Planning them as single-phase deliverables is the main way this plan could go
wrong.
2. **We depend on companion Cursor Automations we do not own.** The system orchestrate
s automations; it does not create them. Someone must hand-author test automations (sco
ping, plan, implementation) that talk to our MCP server, or Phase 2 onward cannot be d
emonstrated. This is the most commonly underestimated dependency in the plan.
---
## Milestones
| Milestone | Achieved after | What it means |
|---|---|---|
| **M1 — Loop proven** | Phase 0 | We know the Cursor orchestration model works and th
e big unknowns are closed |
| **M2 — Usable** | Phase 2 | A team can run real agentic work through the system and
see it tracked and audited |
| **M3 — Governed** | Phase 4 | The system enforces process and controls spend; work c
an be safely left running |
| **M4 — Product** | Phase 6 | Humans live in the inbox rather than the board; the val
ue proposition is visible |
| **M5 — PoC complete** | Phase 9 | All §16 success criteria in `VISION.md` demonstrat
ed |
---
