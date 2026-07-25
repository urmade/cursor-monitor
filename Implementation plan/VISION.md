           0 (%0)           ane — Vision & Feature Spec (PoC)
  Go To Top            (<)  
  Go To Bottom         (>)   built on Cursor for teams where **AI agents execute and h
                            *. This document is the single source of truth for PoC sco
  Search For Agentic (C-r)  r implementation planning.
  Type Agentic       (C-y)  
  Copy Agentic         (c)  
  Copy Line            (l)  
                            
  Horizontal Split     (h)  
  Vertical Split       (v)  an is the worker and the tool is the record. In an agentic
                            n is cheap, parallel, and fast; **human attention is the b
  Swap Up                   
  Swap Down                 
  Swap Marked               with agents." It is a **control plane**:
                            
  Kill                 (X)  owns |
  Respawn              (R)  
  Mark                 (m)  es, labels | Cloud Agents / Automations (the actual agenti
  Zoom                      
                             Agent runtime, models, sandboxes, environments |
| Derived state, attention routing | Code review (Bugbot, Cursor Review) |
| Run tracking, cost, loops | Code intelligence, editor, chat surfaces |
| Specs and decision memory (in our DB) | Repositories |
| Orchestration (which automation fires when) | Creating and editing Automations |

**Core operating rule:** the system tracks state and enforces policy. Any actual agentic work happens outside the system through **Cursor Automations**. The system selects which automation to run at a stage, passes a ticket ID as input, and tracks/audits the run. Agents fetch everything else they need via our MCP server.

---

## 2. What humans still do

Humans move from producing to deciding. Remaining activities the product supports:

| Human activity | How the product supports it |
|---|---|
| Choosing what to build | Projects, ranked backlog, complexity, cost estimates |
| Defining done (when the team wants it) | Optional acceptance criteria; interview/scoping via Cursor Automation |
| Taste (visual, API ergonomics) | Optional visual/interface confirmation gates — only if the project enables them |
| Architecture & tradeoffs | Plan-stage review; decision cards with options |
| Risk acceptance | Risk labels, mandatory human gates defined per project |
| Verifying intent | Attention inbox with evidence from stage reports; Cursor owns code review |
| Answering agent questions | Blocking question protocol with one-click resume |
| Teaching the system (later) | Pattern spotting on approvals/denials → expansion backlog |

---

## 3. Explicit non-goals (PoC)

Out of scope for the PoC. Items marked **backlog** are preserved for later; others are deferred without commitment.

| Area | Status |
|---|---|
| Creating / editing Cursor Automations inside this product | Backlog (orchestrate + track only for PoC) |
| Automation studio UI | Backlog |
| Flexible prompt-defined ticket panels / audience lenses | Future-state backlog |
| Injection fencing / untrusted-content fencing | Out of PoC |
| Self-learning / auto-generated spec templates | Out of PoC |
| Scope-based / path-based gates (system inspecting plan or repo) | Out of PoC — agents set labels instead |
| Repository insights / depending on repo contents | Out of PoC — system is repo-agnostic |
| Third-party PM sync (Jira, Linear, GitHub Issues) | Out of PoC → expansion backlog |
| Parallelism / Best-of-N / collision radar (former F14) | Out of PoC |
| Post-merge / production / uptime signals (former F15) | Out of PoC — lifecycle ends at **Deploy** |
| Failure library injected into agent prompts | Out of PoC (cannot pass large context into runs) |
| Rules / AGENTS.md orchestration and effect measurement | Expansion backlog (pattern spotting OK later) |
| Interop / migration (former F18) | Expansion backlog |
| Policies stored as markdown in the repo | Never for PoC — DB only |

---

## 4. Object model

### 4.1 Project

Human-scale container for related work (renamed from "Initiative").

| Field | Notes |
|---|---|
| Name, description, owner | |
| Pipeline | Ordered stages for this project |
| Labels taxonomy | Project-scoped |
| Policies & gates | **Defined per project**, stored in DB |
| Complexity budget defaults | Default $ (or token) caps for Low / Medium / High |
| Project burn budget | Max spend before new/continuing work is blocked |
| Enabled optional concepts | e.g. acceptance criteria, visual confirmation — off unless humans enable |

### 4.2 WorkItem (ticket)

| Field | Notes |
|---|---|
| Title, description | |
| Project | Parent |
| Complexity | `low` \| `medium` \| `high` — drives default budget and many policies |
| Stage | Current stage in the project pipeline |
| Labels | Including risk and any agent-set labels |
| Owner class | Derived: `ai` \| `human` \| `external` |
| Spec | Versioned structured content in **our DB** |
| Budget | Defaulted from complexity; overridable |
| Cost actuals | Estimated + reconciled |
| Dependencies | Optional for PoC if simple; defer graph sophistication |

### 4.3 Spec

Lives in the system database. Agents fetch via MCP by ticket ID. Not mirrored into the repo for PoC.

Fields are flexible; the system does **not** force acceptance criteria. If a project enables acceptance criteria, they become part of the spec schema for that project.

### 4.4 Pipeline & Stage

Per-project ordered stages. Suggested default (customizable per project):

| Stage | Typical owner | Notes |
|---|---|---|
| Intake | AI (automation) | Normalize, label, complexity suggestion |
| Scoping | AI drafts via automation; human decides Ready | Spec produced by Cursor Automation |
| Plan | AI (automation) | Plan artifact stored on ticket |
| Implementation | AI | |
| Review | AI (Cursor Review / Bugbot) + optional human gate | Code review stays in Cursor |
| Deploy | Terminal for PoC | System is **done** when ticket hits Deploy |

Orthogonal blocking states (not stages): `Needs answer (human)`, `Needs approval (human)`, `Blocked (external)`, `Paused (budget)`, `Failed (run)`, `Abandoned`.

### 4.5 Supporting objects

| Object | Purpose |
|---|---|
| `StageInstance` | One pass through a stage: entered/exited, duration, cost, outcome, linked runs |
| `Run` | One Cursor Automation / agent run: ids, status, duration, tokens, cost, audit fields |
| `StageReport` | Structured AI output posted via MCP (see §7) |
| `Artifact` | Evidence refs (URLs to Cursor artifacts, links) — system stores references, not repo contents |
| `Question` | Agent → human blocking ask |
| `Transition` / `ReturnEdge` | Every stage change; backward edges are loops |
| `Gate` | Project-scoped evaluation rule (human-defined) |
| `Policy` | Project-scoped rules for budgets, stage transitions, automation binding |
| `AutomationBinding` | Maps (project, stage, conditions) → Cursor Automation id to invoke |
| `Approval` | Human decision record |
| `Intervention` | Typed human touch for later analytics |

---

## 5. Complexity, budgets, and cost

### 5.1 Complexity tiers

Three system defaults: **Low / Medium / High**.

Most policies and budget defaults key off complexity. Complexity may be suggested by an intake automation and confirmed or overridden by a human.

### 5.2 Budgets

| Budget | Behavior |
|---|---|
| Per-WorkItem default | Set from project’s Low/Medium/High budget table when complexity is set |
| Per-WorkItem override | Allowed; recorded |
| Project burn budget | Cumulative spend across the project; when exceeded, continuing or starting work is **blocked** until a human raises the cap or pauses items |

Soft warning vs hard block thresholds are policy fields (see gates: Pass / Warn / Block).

### 5.3 Cost tracking and estimation

**During / after runs**

- Track tokens and duration per run (from Cursor Agents API).
- Show **estimated $** from tokens × price table immediately; reconcile to actual charged cents when available (Enterprise admin API), labeled clearly as estimate vs reconciled.
- Roll up: stage → WorkItem → Project.

**Before kickoff (after the system has history)**

- Simple range estimate for new tickets from: complexity, labels, project, historical cost distribution for similar items.
- Shown as a range (p50–p90 style or low/likely/high), not a false point estimate.
- Cold start: fall back to complexity default budgets only until enough history exists.

---

## 6. Orchestration model

```
Human / trigger
    → System evaluates policies & gates for current stage
    → System selects bound Cursor Automation
    → System starts automation/agent with input ≈ ticket ID
    → Agent works in Cursor; fetches spec, history, posts reports via MCP
    → System observes run (SSE / poll / hooks / webhook where available)
    → On completion: ingest StageReport, update cost/time, re-evaluate gates
    → Advance, warn, block, or return (loop) per gate outcomes
```

### 6.1 What the system does

- Maintain authoritative ticket state.
- Bind stages (+ conditions) to Cursor Automation IDs.
- Start runs with **minimal input** (ticket ID; optionally stage name).
- Track and audit every run.
- Enforce gates and budgets.
- Route human attention.
- Record loops and interventions.

### 6.2 What the system does not do

- Create or edit Cursor Automations (PoC).
- Run its own coding agents.
- Inject large context or failure libraries into automation prompts.
- Read or analyze repository contents.
- Write policies into repo markdown.

### 6.3 Automation bindings

Humans (or admins) configure: *for this project, at this stage, when these conditions match (labels, complexity, risk, …), run this Cursor Automation*.

Conditions are evaluated on **system-held fields** (labels, stage, complexity, risk, cost, loop count) — not on inferred file paths from a plan.

**Critical-path / blast-radius handling:** instruct Automations (outside this system) to **set labels** on the ticket via MCP when they detect sensitive areas. Gates then key off those labels. The system never assumes scope from plan text.

---

## 7. Stage reports (structured AI output)

Agents post a structured report via MCP when a stage run finishes (enforced by convention / Cursor hooks in the automation’s repo setup — outside our product, but required for the integration to work well).

Minimum useful schema:

```json
{
  "ticket_id": "...",
  "stage": "implementation",
  "outcome": "complete | partial | blocked | failed",
  "confidence": 0.0,
  "headline": "one line",
  "summary": "short markdown",
  "assumptions": [],
  "not_verified": [],
  "questions": [{ "text": "...", "blocking": true, "options": [] }],
  "labels_to_set": ["risk:high", "touches:auth"],
  "acceptance_criteria": [],
  "artifact_refs": []
}
```

`acceptance_criteria` is only meaningful if the project enabled that concept. `labels_to_set` is the preferred way for agents to signal risk/critical paths.

**UI:** progressive disclosure on the ticket — headline → structured report → link out to Cursor run/transcript.

---

## 8. Gates and policies

### 8.1 Principles

- **Defined by humans**, per **Project**, stored in the **system DB**.
- The system may evaluate **agentic gates** (an LLM call that vets whether a spec or report meets stated standards) and return Pass / Warn / Block.
- If the outcome requires a **rewrite or more agent work**, that work is done by triggering a **Cursor Automation**, not by an internal agent loop owned by this product.
- Gates are steered by **labels, stage, complexity, risk, cost, loop count, report fields** — not by repository scope or plan-derived path assumptions.

### 8.2 Gate outcomes: Pass / Warn / Block

| Outcome | Effect |
|---|---|
| **Pass** | Allow transition / continue |
| **Warn** | Allow continue but attach warning as durable context on the ticket and surface in inbox / stage UI; downstream gates and humans can use it |
| **Block** | Stop advancement; require human decision and/or trigger a bound remediation automation |

Ambiguity / quality checks should prefer **Warn** when uncertain rather than silent Pass or hard Block, so gate definitions can treat warnings as additional context (e.g. “Block if warnings > 0 on Ready” vs “Allow with warnings visible”).

### 8.3 Gate types (PoC)

| Type | Evaluator | Example |
|---|---|---|
| Field / rule gate | Deterministic | Complexity set; required labels present; budget remaining |
| Human approval gate | Human | “Ready for implementation requires human Pass” |
| Agentic gate | LLM against a rubric stored on the gate | “Does this spec have testable outcomes?” → Pass/Warn/Block |
| Budget gate | Deterministic | Soft warn at 80% of item budget; block at 100%; project burn block |

### 8.4 Policy vs gate

- **Policy:** broader project rules (default budgets by complexity, which automation binds to which stage, whether optional concepts are enabled, loop budget, who can override).
- **Gate:** a specific check at a transition (or on events like run finished / label added).

Both live in DB, versioned enough to audit “what rule fired.”

### 8.5 Policy studio (open design question)

Putting every policy control on the pipeline board may overload the UI. **Evaluate a dedicated Policy Studio** (per project) for defining gates, budgets, automation bindings, and optional concepts — with the pipeline board remaining a runtime view (stages, WIP, what’s blocked). Decision to be made in implementation planning; both are in PoC consideration, Automation Studio is not.

---

## 9. Optional concepts (project-configured)

The system must not force process onto teams. These are **opt-in per project**:

| Concept | If disabled | If enabled |
|---|---|---|
| Acceptance criteria | Not required on spec; not shown as missing | Spec may include criteria; gates/UI may reference them |
| Visual / design confirmation | No such gate or stage expectation | Project may add a human (or agentic) gate requiring preview evidence |

Defaults: **off**. Humans turn them on when they want them.

---

## 10. Feature list (PoC)

Numbering is stable for planning. Former large features that were cut are listed in §14.

### F1 — Projects, WorkItems, derived state

- Project CRUD with pipeline, labels, budgets, optional concepts.
- WorkItem with complexity, labels, stage, spec (DB), budget.
- **Derived status** from runs + gate outcomes + questions (manual override recorded as override).
- Owner class derived (`ai` / `human` / `external`).
- Correlation: WorkItem ↔ stage instance ↔ Cursor run ids (handle Cursor’s per-agent git snapshot quirks in our bookkeeping).

### F2 — Specs and scoping (via Cursor Automations)

- Spec stored and versioned in DB; MCP read/write for agents.
- “One-liner → drafted spec” is a **Cursor Automation** bound to Intake/Scoping, not an internal transform engine.
- Human Ready decision as a gate.
- **Ambiguity / quality** surfaced via agentic gates as Pass / **Warn** / Block.
- Open questions on the ticket from stage reports / agentic gates.
- Out of PoC: injection fencing, self-learning templates.

### F3 — Stages, labels, board

- Per-project stages and transitions.
- Labels as primary steering mechanism for policies (including agent-set labels).
- Board with clear **Needs me / AI working / Blocked / Done (Deploy)** separation.
- Stage timers (elapsed in stage; optional baselines later).
- Loop badge + journey ribbon (return edges).

### F4 — Automation orchestration & run audit

- Bind Cursor Automation ids to stage + conditions.
- Start run with ticket ID; track status, duration, tokens, cost, errors.
- Audit log: who/what triggered, which automation, gate results, transitions.
- No in-app Automation authoring (PoC).

### F5 — Structured stage reports & ticket UI

- MCP endpoint for posting reports / labels / questions / artifacts refs.
- Progressive disclosure UI.
- Link to Cursor agent URL for full transcript.

### F6 — Gates & Policy Studio (or board-embedded policies)

- CRUD gates/policies per project in DB.
- Deterministic + human + agentic evaluators.
- Pass / Warn / Block outcomes with Warn as first-class context.
- Budget gates at item and project level.
- Design spike: Policy Studio vs board-embedded configuration.

### F7 — Attention inbox

- Default landing: ranked items needing human action (blocking questions, required approvals, budget blocks, failed runs, loop escalations).
- Each row explains why and offers approve / answer / return / kill-run / raise budget.
- Clear “AI working — nothing needed” state elsewhere.

### F8 — Questions protocol

- Agents ask blocking questions via MCP.
- Ticket → `Needs answer`; notify; answer resumes by triggering the appropriate follow-up automation/run.
- Modeled entirely in our system (Cursor has no durable “needs input” state).

### F9 — Cost, time, estimates

- Live and historical cost/time per run/stage/item/project.
- Complexity-based default budgets; project burn cap.
- Historical range estimates once enough data exists.

### F10 — Loops / rework

- First-class return edges with reason codes.
- Loop count badge; optional loop budget policy (warn/block/escalate).
- Cumulative loop cost/time on the ticket.

### F11 — Webhooks, API, MCP

- Outbound signed webhooks for ticket/stage/run/gate/question events.
- REST API for all core objects.
- **MCP server** (load-bearing): get ticket/spec, post report, set labels, ask questions, attach artifact refs, read gate/warning context.
- Delivery inspector for webhooks.

### F12 — Cursor integration (consume only)

- Cloud Agents API / SDK: create/follow-up/cancel/status/usage as needed to **invoke and observe** automations/agents.
- SSE/poll + optional hooks for progress; do not assume rich v1 webhooks.
- Bugbot / Cursor Review: **out of band** — humans use Cursor for code review; we only track stage/labels/approvals the project defines. Deep findings ingestion can be thin or backlog if not required for PoC.
- No dependency on reading the git repo from our backend.

### F13 — Analytics (thin for PoC)

- Human touch count / time where measurable.
- Cost per item; spend vs budget.
- Rework/loop rate.
- Gate Pass/Warn/Block rates.
- Defer: trust index, model leaderboards, intervention→rule measurement.

---

## 11. Surfaces (PoC UI)

1. **Attention Inbox** — default home.
2. **WorkItem detail** — spec, stage timeline + reports, warnings, loops, cost/time, questions, linked runs.
3. **Pipeline board** — runtime view by stage / attention swimlanes.
4. **Project settings** — budgets by complexity, burn cap, optional concepts, label taxonomy.
5. **Policy Studio** (preferred exploration) — gates, automation bindings, transition rules — *or* equivalent controls if embedded in the board without overload.
6. **Run / audit views** — per ticket and per project.

Not in PoC UI: Automation Studio, flexible custom panels, fleet ops extravagance, third-party sync settings.

---

## 12. MCP contract (agent-facing, PoC)

Agents receive **ticket ID** (and maybe stage). They use MCP roughly as follows:

| Tool | Purpose |
|---|---|
| `get_ticket` | Core fields, stage, labels, complexity, budgets, warnings |
| `get_spec` | Current spec document |
| `update_spec` | Write/merge spec fields (scoping automation) |
| `post_stage_report` | Structured report for current stage |
| `set_labels` | Add/remove labels (risk, touches:\*, etc.) |
| `ask_question` | Blocking or non-blocking human question |
| `attach_artifact_ref` | Store URL/ref to Cursor artifact |
| `get_gate_context` | Recent gate results and warnings |
| `list_questions` / resolve is human-side | |

No bulk “here is our failure library” injection. Agents pull what they need.

---

## 13. Build tiers (PoC sequencing)

### Tier 0 — Wedge

- Projects, WorkItems, complexity, DB specs.
- Stages + transitions + labels.
- MCP + run invoke/track against Cursor.
- Stage reports, questions, attention inbox.
- Basic Pass/Block gates (human + deterministic); Warn support in the model even if few Warn gates ship first.
- Budgets from complexity + project burn block.
- Loop recording.

### Tier 1 — Control

- Agentic gates (LLM Pass/Warn/Block).
- Automation bindings with conditions.
- Policy Studio (or validated board-embedded UX).
- Cost reconciliation + historical range estimates.
- Optional acceptance criteria / visual confirmation as project flags.
- Webhooks + audit completeness.

### Tier 2 — Harden

- Richer analytics, baselines for stage time/cost.
- Stronger anomaly warnings into inbox.
- Polish on journey ribbon, batch inbox actions.
- Whatever thin Cursor Review/Bugbot status mirroring proves necessary.

---

## 14. Expansion & future-state backlog

Preserve without building now:

| Item | Notes |
|---|---|
| In-app Cursor Automation creation | After orchestration proves out |
| Automation Studio | |
| Prompt-defined ticket panels / lenses | Former flexible UI components discussion |
| Jira/Linear/GitHub sync | Former F18 |
| Rules flywheel + effect measurement | Spot denial patterns later; effect hard without repo rule visibility |
| Failure library | Blocked by “no large prompt injection” constraint unless agents pull summaries themselves via MCP |
| Best-of-N, collision radar | Former F14 |
| Post-deploy verification, Sentry/PagerDuty | Former F15; resume after Deploy-stage end state changes |
| Scope/path gates from plan analysis | Prefer agent-set labels indefinitely unless strategy changes |
| Repo-coupled policy files | Explicitly avoided |
| Injection fencing, learned spec templates | |
| Trust index / progressive autonomy | |

---

## 15. Default complexity → budget (illustrative)

Exact numbers are configuration, not product constants. Projects start with a table like:

| Complexity | Soft warn | Hard block (item) |
|---|---|---|
| Low | $X | $Y |
| Medium | $X | $Y |
| High | $X | $Y |

Plus project-level burn budget **$Z** that blocks further spend when crossed.

---

## 16. Success criteria for the PoC

The PoC is successful if a team can:

1. Create a **Project** with stages, labels, complexity budgets, and a project burn cap.
2. Define **gates** (including at least one human gate and one agentic Pass/Warn/Block gate) without touching a repo.
3. Bind **existing** Cursor Automations to stages; run them with only a ticket ID; see runs audited with time and cost.
4. Have agents **fetch/update spec and post reports via MCP**, including setting labels that later gates honor.
5. Use the **inbox** to answer questions and approve Ready/Deploy-related gates without updating status by hand.
6. See **loops** when work returns from review-like stages to earlier stages.
7. Hit **Deploy** as the terminal stage and stop.
8. After some history, see a **cost range estimate** on new tickets from complexity + past spend.

---

## 17. Open decisions for implementation planning

1. **Policy Studio vs board-embedded policies** — pick a UX direction early; prefer Studio if the board feels overloaded in mocks.
2. **How we invoke Cursor Automations** — Agents API vs automation webhook trigger vs both; document the chosen path and auth model (service account).
3. **Agentic gate runner** — where the LLM call executes (our backend vs a dedicated Cursor automation); prefer our backend for Pass/Warn/Block so rewrites still go through bound Automations.
4. **Warn accumulation** — do warnings expire on stage exit, persist for ticket lifetime, or until explicitly dismissed?
5. **Cold-start cost estimates** — minimum n of historical items before showing ranges.
6. **Thin vs no Bugbot ingestion** — for PoC, labels + human gates may suffice.
7. **AuthN/Z model** — project membership, who may edit gates/bindings, who may raise budgets.

---

## 18. One-line summary

**Projects and tickets in our DB; humans define per-project policies and gates (Pass/Warn/Block); we orchestrate and audit Cursor Automations that do all agentic work with ticket-ID-only input and MCP for context; humans live in an attention inbox until Deploy.**
