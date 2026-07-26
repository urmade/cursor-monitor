# Phase 6 — Attention

> **Outcome.** "The inbox becomes the product's home, and humans stop scanning the board. Everything needing a person is ranked in one place, each row explains why it is there and what decision is being asked, and each row can be acted on without opening the ticket. Answering a blocking question resumes the work by triggering the appropriate automation. Notifications reach people outside the app."
>
> **Proof.** With several tickets in flight, the inbox shows exactly the items needing a human — blocking questions, pending approvals, budget blocks, failed runs, loop escalations — correctly ranked, each self-explaining. A question is answered from the inbox and the work resumes without anyone touching a stage field. Everything else is visibly and unambiguously "AI working, nothing needed from you."
>
> **Milestone.** M4 — Product. **Depends on.** Phase 2 (questions, failed runs), Phase 3 (approvals, warnings), Phase 4 (budget blocks), Phase 5 (loop escalations). **Unblocks.** The product thesis becoming visible.

---

## 1. Objective and scope

Every phase so far produced a reason to interrupt a human. Phase 6 is where those reasons stop being scattered across tickets and become a single ranked queue. `VISION.md`'s thesis — human attention is the bottleneck — is only demonstrable here.

The bar is trust, and trust has two failure modes that pull in opposite directions:

- **Missing something.** An item that needed a person and never appeared. A thin inbox that misses things is worse than no inbox, because people stop checking the board once they believe the inbox is complete.
- **Crying wolf.** Rows that did not need a human, or that stay after being handled. Two false rows and people start skimming.

Both are addressed structurally rather than by care: completeness comes from a reconciliation job that rebuilds the queue from source state and reports any drift (D14); precision comes from resolution being automatic and event-driven, never manual housekeeping.

### In scope

The materialised attention item projection with reconciliation; a deterministic, explainable ranking function; the inbox as the default landing surface; inline actions for every item type; the resume protocol hardened to production quality; out-of-app notifications; attention swimlanes and an unambiguous "AI working" state on the board.

### Out of scope

| Not in Phase 6 | Lands in |
|---|---|
| Batch actions across many items | Phase 9 polish, if earned |
| Per-person ranking preferences and saved views | Phase 9 polish, if earned |
| Digest emails | Phase 9 at the earliest |
| Assignment and routing to specific people | Not in the PoC — the inbox is team-shared, filtered by project membership |
| Mobile-specific layouts | Not planned |

---

## 2. Preconditions

- Phases 2 through 5 complete, since they are the sources. Building the inbox against two of five sources produces exactly the thin version the plan warns about.
- Q15 answered: which notification channels matter. Default is in-app plus a Slack incoming webhook per project.
- A decision on whether the inbox is per-user or team-shared. Default: **team-shared, scoped to the projects you are a member of**, with a "needs someone with maintainer rights" flag on rows only certain roles can action.

---

## 3. Technical approach

### 3.1 The projection

```ts
type AttentionItem = {
  id: string;
  projectId: string; workItemId: string;
  kind: 'blocking_question' | 'pending_approval' | 'budget_block' | 'run_failed'
      | 'run_completed_no_report' | 'loop_escalation' | 'external_block';
  sourceType: string; sourceId: string;       // the question/approval/run/edge it reflects
  title: string;                               // "Answer: which auth provider should we target?"
  why: string;                                 // one sentence, human-authored template
  askedOf: 'anyone' | 'maintainer' | 'owner';
  status: 'open' | 'resolved' | 'dismissed';
  score: number; scoreExplain: ScoreBreakdown;
  actions: AttentionAction[];                  // typed, permission-checked at render and at execution
  createdAt: Date; resolvedAt: Date | null; resolvedBy: Actor | null;
  snoozedUntil: Date | null;
};
```

Maintained by event handlers, one per source:

| Event | Effect |
|---|---|
| `question.asked` (blocking) | Create `blocking_question` |
| `question.answered` / `withdrawn` | Resolve it |
| `gate.blocked` with a human approval gate | Create `pending_approval` |
| `approval.decided` | Resolve it |
| `budget.blocked` | Create `budget_block` |
| `budget.cap_raised` / `item.resumed` | Resolve it |
| `run.failed`, `run.completed_without_report` | Create the matching kind |
| `run.launched` on the same item | Resolve the prior failure row (someone clearly dealt with it) |
| `loop.escalated` | Create `loop_escalation` |
| `work_item.stage_changed` forward | Resolve the escalation |
| `work_item.archived` | Resolve everything for the item |

**Reconciliation.** `reconcile_attention` runs every five minutes: it recomputes what *should* be open from source tables, creates anything missing, resolves anything stale, and writes a drift record. A non-zero drift is a bug report, not a routine correction — the job logs it loudly and Phase 9 reports the trend. This is what makes "the inbox is complete" a claim we can defend rather than hope.

### 3.2 Ranking

Deterministic, explainable, and never a model call (D15):

```ts
score = base[kind]
      + ageBoost(hoursOpen)          // log-scaled, capped
      + complexityBoost(item)        // high-complexity work waiting costs more
      + spendAtRiskBoost(item)       // a paused item with sunk cost outranks a fresh one
      + loopBoost(item.loopCount)
      - snoozePenalty(snoozedUntil);
```

with base weights roughly `blocking_question 100`, `budget_block 90`, `run_failed 80`, `run_completed_no_report 80`, `pending_approval 70`, `loop_escalation 60`, `external_block 40`. Every contribution is stored in `scoreExplain`, and the UI can show "ranked high because: blocking question (100) + open 6h (+12) + high complexity (+10)". The weights live in configuration, not in code constants, so they can be tuned without a deploy — but they are the same for everyone (per-person preferences are explicitly deferred).

Rows are grouped by kind before being ranked within groups, because a flat mixed list reads as noise. The default view is "everything, grouped, ranked"; filters are project, kind, and age.

### 3.3 Actions

Each kind carries typed actions, executed through the same core services the ticket page uses — no duplicate logic, no inbox-only shortcuts:

| Kind | Actions |
|---|---|
| `blocking_question` | Answer (free text or one of the supplied options) → resumes work; Withdraw; Open ticket |
| `pending_approval` | Approve with comment; Reject with comment; Open ticket |
| `budget_block` | Raise item budget; Raise project cap; Pause deliberately; Open ticket |
| `run_failed` | Retry the stage; Open the Cursor run; Return to an earlier stage; Open ticket |
| `run_completed_no_report` | Retry; Accept and advance manually (recorded as an override); Open ticket |
| `loop_escalation` | Return with reason; Change complexity; Raise budget; Open ticket |
| `external_block` | Clear the block; Open ticket |

Every action is optimistic in the UI with rollback on failure, resolves its row immediately, and records an `intervention` (the table Phase 3 created for exactly this).

### 3.4 The resume protocol, hardened

Phase 2 made answering a question resume the work. Phase 6 makes it reliable, because this is the interaction the demo hinges on:

```
answer submitted
  ├─ persist the answer (question.answered)
  ├─ resolve the attention row
  └─ enqueue resume_run:
       ├─ original agent still active and idle → POST /v1/agents/{id}/runs with the answer
       ├─ agent busy (409 agent_busy)          → retry with backoff, then fall back
       ├─ agent archived/expired/deleted       → launch a fresh run on the stage's binding,
       │                                          with the question and answer in the prompt context
       └─ no binding resolves                  → surface "cannot resume automatically" on the ticket
                                                  with a manual Run stage action, and say why
```

Every branch is visible on the ticket. Silent non-resumption would be the single most damaging bug in this phase: the human believes they unblocked the work and nothing happens.

### 3.5 "AI working, nothing needed"

The negative space matters as much as the queue. An empty inbox must be affirmative, not blank: how many items are in flight, what stages they are in, what the oldest active run is, and when the last human action was needed. A blank page reads as "broken"; a summary reads as "working".

The board gains attention swimlanes — **Needs me / AI working / Blocked externally / Done** — so the board's job becomes situational awareness while the inbox owns decisions, exactly the split `VISION.md` §11 describes.

### 3.6 Freshness

Inbox lists poll every 15 seconds through TanStack Query, with immediate invalidation after any local mutation and a visible "updated Ns ago" indicator. Server-Sent Events for the inbox were considered and rejected: on Vercel a long-lived stream per viewer is expensive and fragile, and a 15-second lag on a queue whose items live for minutes is imperceptible. Active run views keep the Phase 2 stream proxy.

---

## 4. Data model changes

```sql
-- 0013_attention.sql
create table attention_items (
  id uuid primary key,
  project_id uuid not null references projects(id),
  work_item_id uuid not null references work_items(id),
  kind text not null,
  source_type text not null, source_id uuid not null,
  title text not null, why text not null,
  asked_of text not null default 'anyone' check (asked_of in ('anyone','maintainer','owner')),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  score integer not null default 0, score_explain jsonb not null default '{}',
  snoozed_until timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz, resolved_by jsonb, resolution text
);
create unique index attention_unique_open on attention_items (source_type, source_id) where status = 'open';
create index attention_queue on attention_items (project_id, status, score desc, created_at)
  where status = 'open';

create table attention_reconciliations (
  id uuid primary key,
  ran_at timestamptz not null default now(),
  created integer not null, resolved integer not null, drift integer not null,
  detail jsonb not null default '{}'
);

create table notification_channels (
  id uuid primary key,
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('slack_webhook')),
  secret_key text not null,                -- reference into secrets/, never a value
  min_kind_severity text not null default 'all',
  enabled boolean not null default true
);

create table notification_deliveries (
  id uuid primary key,
  channel_id uuid not null references notification_channels(id),
  attention_item_id uuid references attention_items(id),
  status text not null, attempts integer not null default 0,
  last_error text, delivered_at timestamptz,
  created_at timestamptz not null default now()
);
```

The partial unique index on `(source_type, source_id) where status = 'open'` is the structural guarantee against duplicate rows: the projection can be re-run as often as we like and cannot produce two rows for one question.

---

## 5. Interfaces

```ts
// packages/core/src/attention
projectEvent(ctx, event): Promise<void>              // called by the event dispatcher
listInbox(ctx, { projectIds, kinds, limit, cursor }): Promise<AttentionPage>
countInbox(ctx, { projectIds }): Promise<Record<Kind, number>>
executeAction(ctx, { attentionItemId, action, payload }): Result<ActionResult>
snooze(ctx, id, until, reason): Result<AttentionItem>
reconcile(ctx): Promise<ReconciliationSummary>       // job handler
```

`executeAction` is a thin dispatcher onto existing services (`questions.answer`, `approvals.decide`, `budgets.raiseProjectCap`, `runs.launchRun`, `loops.recordReturnEdge`). It exists so permission checks, resolution, intervention recording, and error mapping happen in one place rather than in seven UI handlers.

**UI.** `/inbox` becomes the post-login landing route (project list moves to a nav item):

```
Inbox · 6 need you                                    [All projects ▾] [All types ▾]

NEEDS AN ANSWER (2)
  ⛔ ACME-14  Which auth provider should we target?                    6h · High · $4.10 spent
     Scoping run stopped and asked. Options: Okta · Auth0 · Custom
     [Okta] [Auth0] [Custom] [Answer…]  [Open ticket]

BUDGET (1)
  💰 ACME-9   Blocked at 100% of $50.00 item budget                    22m · High
     Implementation run refused before launch.
     [Raise to $75] [Raise project cap] [Pause] [Open ticket]

…

AI WORKING — nothing needed from you
  8 items in flight · oldest run 12m · next expected report ~4m
```

---

## 6. Implementation steps

### Step 6.1 — The projection and its reconciliation

**Changes.** The event dispatcher (a job that reads new `events` rows and fans them to handlers — the first real consumer of the Phase 1 outbox); one handler per source with title and `why` templates; the `attention_items` schema; `reconcile_attention` every five minutes with drift recording; `/api/health` reporting last reconciliation and drift.

**Done when.** Seeding twenty items across all five sources and running reconciliation from an empty table reproduces exactly the expected rows; resolving each source resolves its row within one tick; injected drift is detected and reported.

---

### Step 6.2 — Ranking

**Changes.** The scoring function with configurable weights; `scoreExplain` capture; a re-scoring job (ages change scores, so open rows are re-scored every tick); a `describeScore()` renderer for the UI.

**Done when.** A fixture of thirty items ranks in the order a human reviewer agrees with, and every row can explain its position in one sentence.

---

### Step 6.3 — The inbox surface

**Changes.** `/inbox` route with grouped, ranked rows, filters, and keyboard navigation (`j`/`k` to move, `Enter` to expand, `1`–`9` for the primary actions, `s` to snooze); the affirmative empty state; unread-style counts in navigation; per-row permission awareness (an action a viewer cannot take is explained, not hidden).

**Done when.** A person can clear a six-item inbox entirely from the keyboard, and the empty state tells them what is happening rather than showing nothing.

---

### Step 6.4 — Inline actions

**Changes.** `executeAction` and the seven action families; optimistic UI with rollback; confirmation only for irreversible or spend-increasing actions (raising a cap confirms; answering a question does not); intervention recording; error surfacing that keeps the row and explains the failure.

**Done when.** Every action in §3.3 works from the inbox and produces the same state as performing it on the ticket, asserted by paired tests.

---

### Step 6.5 — Resume, hardened

**Changes.** The full branch matrix of §3.4 with tests for each; ticket and inbox visibility of resume state ("resuming…", "resumed as run #3", "could not resume automatically — Run stage to continue"); a resume timeout that surfaces failure rather than leaving a spinner.

**Done when.** All four branches are demonstrable on preview, including the archived-agent fallback, and no branch can end in silence.

---

### Step 6.6 — Notifications

**Changes.** Per-project Slack incoming webhook (URL stored via `scripts/secrets.py`, referenced by key); message templates per kind with a deep link into the inbox row; severity filtering; delivery retries with backoff and a delivery log; a per-channel rate limit and coalescing (at most one message per item per hour, and a rolled-up message when more than five items arrive in five minutes).

**Done when.** A blocking question posts to Slack within a minute, the link lands on the right row, and a burst of ten items produces one rolled-up message rather than ten.

---

### Step 6.7 — Board swimlanes and the "AI working" state

**Changes.** Attention swimlanes on the board; consistent status treatments shared with the inbox (one component, two placements); the in-flight summary component reused in both the empty inbox and the board header.

**Done when.** A person looking at the board can tell in two seconds whether anything needs them, and the answer always agrees with the inbox count.

---

### Step 6.8 — Hardening and flag removal

**Changes.** A performance pass for an inbox spanning ten projects and several hundred open rows (index review, keyset pagination, count caching); an accessibility pass (focus management, live-region announcements for resolved rows, keyboard traps); a runbook section "an item is missing from the inbox" walking the reconciliation path; flag removal.

**Done when.** The inbox renders in under 300 ms server time at demo scale, passes an accessibility audit, and reconciliation reports zero drift over a 24-hour soak.

---

## 7. Testing and verification

- **Unit.** Ranking determinism and monotonicity (an older item never ranks below an identical newer one); `why` template rendering for every kind; action permission mapping.
- **Integration.** Each source event creating and resolving exactly one row; reconciliation converging from a deliberately corrupted table; concurrent action execution (two people answering the same question — the second gets a clear "already answered", not an error page); paired ticket-versus-inbox action equivalence.
- **Resume matrix.** All four branches with a fake provider, including `409 agent_busy` retry and the fresh-agent fallback.
- **Soak.** A 24-hour run in preview with agents active, asserting zero reconciliation drift and no orphaned rows.
- **End-to-end.** The demo script automated: several items in flight, answer from the inbox, work resumes, row disappears.

## 8. Rollout and safety

- Flag `p6.inbox`. Until enabled, `/inbox` is reachable but not the landing route, so it can be dogfooded before it becomes the front door.
- The projection is additive: turning it off leaves every source surface (ticket panels, pending lists) working exactly as before. The inbox is a lens, never the only path.
- Notifications are opt-in per project and default off, so a mis-tuned rule cannot spam a channel.
- Snooze is capped at 24 hours so nothing can be hidden indefinitely, and snoozed rows remain visible under a filter.

## 9. Demo script (the proof)

1. **Set the scene.** Eight tickets in flight across two projects: some running, one with a blocking question, one awaiting approval, one budget-blocked, one failed run, one loop-escalated.
2. **Land on the inbox.** Sign in — the inbox is the landing page. Six rows, grouped and ranked. Read the top row aloud: it explains itself without anyone opening a ticket.
3. **Explain the ranking.** Expand the score explanation on the top two rows and show why one outranks the other.
4. **Answer without touching a stage field.** Answer the blocking question by choosing one of the agent's options. The row resolves; the ticket shows the answer and a resume run starting. Nobody edited a stage, a status, or a checkbox.
5. **Approve.** Approve the pending gate from the inbox; the held transition completes automatically.
6. **Money.** Raise the item budget on the budget-blocked row; it becomes runnable and the block plus override appear in the Spend view.
7. **Failure.** Retry the failed run from the inbox; a new run starts and the row resolves.
8. **The negative space.** With the queue empty, show the affirmative state: eight items in flight, oldest run twelve minutes, nothing needed. Then the board: everything sitting in "AI working", with the counts agreeing.
9. **Outside the app.** Trigger a new blocking question and show the Slack message arriving with a link straight to the row.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| Something needing a human never appears | A user finds a stuck ticket that was not in the inbox | Reconciliation every five minutes with drift reported as a bug; a health check surfaces drift; the soak test gates the phase |
| Rows linger after being handled | Users manually dismiss rows | Resolution is event-driven from source state, never manual; dismissal exists but is recorded and reported as a smell |
| Ranking is disputed | "Why is that at the top?" | Every row explains its score; weights are configuration, tunable without a deploy |
| Resume fails silently | A human answers and nothing happens | Four explicit branches, all visible on the ticket, with a timeout that surfaces failure |
| Notification fatigue | Channel muted by the team | Coalescing, per-item hourly cap, severity filter, default off |
| The inbox becomes a second board | Sorting, columns, and drag requests appear | The inbox is a decision queue; situational awareness stays on the board. Say no |
| Team-shared inbox causes collisions | Two people act on one row | Optimistic concurrency with a clear "already handled by X" message, and resolved rows animate out for everyone within a poll |

## 11. Exit criteria

- [ ] All five sources produce attention items, and reconciliation shows zero drift over a 24-hour soak.
- [ ] Every row explains why it exists and what decision is being asked, in one sentence.
- [ ] Every row can be actioned from the inbox with the same result as acting on the ticket.
- [ ] Answering a blocking question resumes the work, with all four resume branches visible and tested.
- [ ] Ranking is deterministic and explainable per row.
- [ ] The empty state affirmatively reports what the system is doing.
- [ ] The board shows attention swimlanes whose counts agree with the inbox.
- [ ] Slack notifications deliver, coalesce, and deep-link correctly.
- [ ] The inbox is the landing route and performs at demo scale.

## 12. Open questions for this phase

- **Q15** — notification channels. Default: in-app plus Slack per project.
- **Local:** per-user or team-shared inbox? Default: team-shared, membership-scoped, with role hints on rows. Per-user assignment is a bigger product commitment than the PoC needs.
- **Local:** should an item awaiting an approval only the owner can give appear for everyone? Recommendation: yes, marked "needs owner" — hiding work in progress from the team is worse than a row someone cannot action.
- **Local:** does resolving a row require the resolving action to succeed end to end (for example, resume actually starting)? Recommendation: resolve on the human decision, and surface resume failure as a *new* row of kind `run_failed`. Keeping a row open pending a background outcome makes the queue feel unresponsive.
