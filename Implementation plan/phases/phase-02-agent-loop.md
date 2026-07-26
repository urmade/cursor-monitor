# Phase 2 — The agent loop

> **Outcome.** "The system can put agentic work in motion and account for it. A stage can be bound to an existing Cursor Automation; the system starts that automation passing only a ticket identifier; the agent fetches the spec and ticket context through MCP, writes results back as a structured stage report, sets labels, and can raise a blocking question; the system records the run with its status, duration, token usage, and outcome, and links out to the run in Cursor."
>
> **Proof.** A one-line ticket enters Intake. The bound scoping automation runs, writes a real spec into our database, and posts a stage report with labels. The ticket detail page shows the report at headline level, expandable, with the run's duration and token usage and a working link to Cursor. A second run on the same ticket appends rather than overwrites. One run is deliberately failed and shows as a failed run rather than a silently stuck ticket.
>
> **Milestone.** M2 — Usable. **Depends on.** Phase 0, Phase 1, and companion automations authored outside this system. **Unblocks.** Gates, cost, loops, attention.

### Phase 0 observations that shape this phase (2026-07-26)

> Source: `docs/decisions/phase-0-report.md`, ADR-0002–0005, evidence `04`–`06`. These change how we implement the outcome — not whether the outcome stands.

- **Primary invocation path is Cloud Agents API + injected MCP** (ADR-0002). Live Spike A: no-repo agent called `spike_get_ticket` / `spike_post_report` on a Passport-protected preview with per-run bearer + bypass (`evidence/04-spike-a-live.md`).
- **Spike B (automation webhook) deferred on Q4** — no Nexus webhook automation exists (`evidence/06-spike-b-blocker.md`). Keep the `automation_webhook` adapter as a port; do not block launcher/observer work on it. Companion automations remain required to close the phase's binding/demo story (step 2.9); until they exist, demos can use the `cloud_agent` adapter with a thin prompt template (D5).
- **`completed_without_report` is live-proven** (`evidence/05-completed-without-report.md`). Provider `FINISHED` without an MCP stage report must never be treated as success. (Named `completed_no_report` in the state machine below — same concept.)
- **Cancel is unreliable.** `POST …/cancel` returned provider `500` and left the run `RUNNING` (`evidence/03-api-failure-probes.md`). Recovery = deadlines + stuck watchdog + poll, not cancel success. UI "Cancel" may still call the API but must surface provider failure honestly.
- **Usage at terminal includes `chargedCents`.** Observer should persist tokens *and* provider cost fields from `GET /v1/agents/{id}/usage` for Phase 4 (ADR-0007).
- **Paths.** MCP/cron routes live at `apps/web/app/api/…` (ADR-0001).
- **Client quirks to absorb.** `model` must be `{ id }`; replay → `409 agent_id_conflict`; busy → `409 agent_busy` — already reflected in `@nexus/cursor-client` from Phase 0.

---

## 1. Objective and scope

This is the phase where the product starts doing something no tracker does. It is also the phase that sets the contract we are least able to change later: `Implementation Phases.md` says the MCP surface is "the most expensive thing to change" and should be settled here.

Four things must become true:

1. **Binding.** A project can say "at this stage, run this automation", and the system resolves that binding when work needs doing.
2. **Launching.** The system starts the work with a ticket identifier and nothing else, mints a credential scoped to that ticket, and records the run before the agent does anything.
3. **Reaching back.** The agent reads ticket, spec, and context through MCP, and writes a spec, a stage report, labels, questions, and artifact references back.
4. **Accounting.** Every run reaches a recorded terminal state with duration, token usage, and an outcome — including the awkward ones: cancelled, expired, errored, and "finished but never reported".

### In scope

The frozen MCP contract; the MCP server; automation bindings and their resolution; the run launcher with per-run credentials; the run observer (poll-first, per D7); stage reports, questions (captured, not routed), artifact references, and agent-set labels; run and report UI on the ticket; usage ingest in tokens; the failure taxonomy; the companion scoping automation needed to demo it.

### Out of scope

| Not in Phase 2 | Lands in |
|---|---|
| Any enforcement — a run can start when it arguably shouldn't | Phase 3 |
| Money. Tokens are recorded; currency is not | Phase 4 |
| Loop interpretation of backward transitions | Phase 5 |
| A ranked inbox. Questions block a ticket visibly; they do not yet rank | Phase 6 |
| LLM evaluation of reports | Phase 7 |
| Public API and outbound webhooks | Phase 8 |

---

## 2. Preconditions

- Phase 0's invocation ADR (`docs/decisions/ADR-0002-invocation-path.md`) is merged and its failure matrix is understood (**Phase 0 observation:** matrix in ADR-0005; demo-critical rows live; cancel/SSE rows noted as probes/fixtures).
- Phase 1 is complete: work items, specs, stage instances, transitions, events, jobs.
- A Cursor **service account** API key exists in `secrets/` — not a personal key, because runs will be attributed to it (Q1). **Phase 0 observation:** service-account key `cloud-agent` already worked for Spike A.
- The protection bypass is in place and proven from Phase 0 (ADR-0004).
- **At least one companion automation for scoping exists** (Q4), *or* the demo uses the proven `cloud_agent` adapter until Q4 lands. **Phase 0 observation:** Spike B is blocked until a webhook automation exists; step 2.9 still required to close the automation-binding proof, but the invoke→MCP→observe loop is already proven on the API path.
- Agreement on the minimum stage report content — settled by step 2.1, before anything consumes it.

---

## 3. Technical approach

### 3.1 The loop

```
human clicks "Run stage" (or a transition triggers it)
   │
   ├─ resolve binding      (project, stage, conditions)     → automation_bindings row
   ├─ pre-flight checks    (no active run; orchestration enabled; item not archived)
   ├─ create run row       (status=pending) + advisory lock on the work item
   ├─ mint run token       (scoped: this work item, this run, TTL)
   ├─ invoke via adapter   (cloud_agent | automation_webhook)
   └─ persist external ids (agent id, run id) → status=launched
              │
              ▼
      agent reads/writes through /api/mcp with the run token
              │
   cron tick ─┴─► poll run → status transitions → on terminal:
                  fetch usage, close out, evaluate "did it report?", emit events
```

### 3.2 The MCP contract, frozen here

Nine tools, matching `VISION.md` §12. They are versioned as a set (`nexus-mcp/1`), and the version is returned in every response envelope so an agent — and we — can tell what it is talking to.

| Tool | Reads / writes | Notes |
|---|---|---|
| `get_ticket` | read | Core fields, stage, labels, complexity, budget headroom (P4), open warnings (P3) |
| `get_spec` | read | Current version by default; `version` argument for history |
| `update_spec` | write | Merge or replace; creates a new version authored by the agent |
| `post_stage_report` | write | The structured report; at most one per run, enforced |
| `set_labels` | write | Add/remove against the project taxonomy; rejects unknown or non-agent-settable keys |
| `ask_question` | write | Blocking or non-blocking; blocking marks the item `needs_answer` |
| `attach_artifact_ref` | write | URL/path plus kind and title; no bytes stored |
| `get_gate_context` | read | Recent gate results and open warnings (returns an empty set until Phase 3) |
| `list_questions` | read | This ticket's questions and any answers |

Design rules, adopted because they are cheap now and painful later:

- **The token defines the ticket.** Every tool takes `ticket_id` and the server checks it against the token's scope; a mismatch is a tool error, never a silent redirect.
- **Envelope everything.** `{ ok: true, contract: 'nexus-mcp/1', data: … }` or `{ ok: false, contract, error: { code, message, retryable, hint } }`. Errors are returned as tool results, not transport errors, so the agent can read and act on them.
- **Idempotency by nature.** `post_stage_report` is once-per-run; a second call returns the first report with `already_posted: true`. `set_labels` is a set operation. `update_spec` accepts an optional `base_version` for conflict detection.
- **Hard limits, stated in the tool description.** Spec 100 KB, report summary 20 KB, question 4 KB, 20 labels per call, 20 artifact refs per run. Descriptions say the limit so agents self-truncate.
- **No pagination games.** Everything a stage needs fits in one response; where it might not (`list_questions`), return the most recent 50 and a count.

Additive changes (new optional field, new tool) do not bump the version. Anything else does, and both versions run in parallel for at least one phase.

### 3.3 The stage report

`VISION.md` §7's schema, formalised in `packages/contracts/src/mcp/stage-report.ts`:

```ts
export const StageReport = z.object({
  ticket_id: z.string().uuid(),
  stage: z.string(),                                   // echoed for sanity checking
  outcome: z.enum(['complete', 'partial', 'blocked', 'failed']),
  confidence: z.number().min(0).max(1).optional(),
  headline: z.string().min(1).max(200),
  summary: z.string().max(20_000).default(''),         // markdown
  assumptions: z.array(z.string().max(1_000)).max(20).default([]),
  not_verified: z.array(z.string().max(1_000)).max(20).default([]),
  questions: z.array(z.object({
    text: z.string().max(4_000),
    blocking: z.boolean().default(false),
    options: z.array(z.string().max(200)).max(10).default([]),
  })).max(10).default([]),
  labels_to_set: z.array(z.string().max(100)).max(20).default([]),
  acceptance_criteria: z.array(z.string().max(1_000)).max(50).default([]),
  artifact_refs: z.array(z.object({
    kind: z.enum(['pr', 'branch', 'preview', 'artifact', 'link']),
    url: z.string().url().max(2_000),
    title: z.string().max(200).optional(),
  })).max(20).default([]),
});
```

Posting a report is a single transaction that writes the report, applies labels, creates questions, stores artifact references, closes out the run's contribution to the stage instance, and emits events. Partial application is not allowed: a report with one invalid label fails wholly, with an error naming the label — agents fix that reliably.

`acceptance_criteria` is accepted whether or not the project enabled the concept; if disabled it is stored on the report but not promoted into the spec and not shown as a spec section (`VISION.md` §9).

### 3.4 Run lifecycle

```
pending ──► launched ──► running ──► completed
   │            │           │      ├─► completed_no_report   (terminal, needs attention)
   │            │           │      ├─► failed
   │            │           │      ├─► cancelled
   │            │           │      └─► expired
   │            └─► launch_failed
   └─► abandoned (pre-flight refused)
```

`completed_no_report` is the state Phase 0 step 0.6 scenario 3 exists to justify: the provider says FINISHED but nothing arrived through MCP. Reporting that as success is the single most dangerous thing this system could do. It is terminal, it is distinct, and in Phase 6 it becomes an inbox item.

> **Phase 0 observation (`evidence/05-completed-without-report.md`).** Live demo with `scenario: "no_mcp"`: provider terminal + no report matching the run nonce → status rewritten to `completed_without_report`, with duration and tokens still recorded. Close-out logic must preserve that distinction.

A `stuck` watchdog complements it: a run that has been `launched` without provider acknowledgement, or `running` past its deadline, is force-terminated and recorded with the reason. **Phase 0 observation:** do not implement "stuck recovery" as "call cancel and trust the provider" — cancel returned `500` while the run stayed `RUNNING` (ADR-0003).

### 3.5 Observation

Per D7 (confirmed ADR-0003), a job (`poll_run`) per active run, rescheduling itself with adaptive delay: 5 s for the first minute, 15 s to five minutes, then 60 s, with a per-run deadline (default 60 minutes, configurable per binding). On terminal it fetches `GET /v1/agents/{id}/usage?runId=…`, stores token counts, `usageUuid`, and **provider cost fields (`chargedCents` / `rawCostCents`) when present** (**Phase 0 observation / ADR-0007:** these arrive promptly on the usage endpoint), records `git.branches[]` as a **best-effort, agent-scoped** snapshot (per the documented quirk), and enqueues the close-out.

The SSE stream is used only by the UI, and only while a user watches a run: a route handler proxies it, and any failure — including `410 stream_expired` — degrades silently to polling. No state is ever derived solely from the stream.

### 3.6 Bindings and prompts

```ts
type AutomationBinding = {
  id: string; projectId: string; stageId: string;
  name: string;
  adapter: 'cloud_agent' | 'automation_webhook';
  condition: ConditionAst | null;      // Phase 3's DSL; Phase 2 supports null + label filters
  priority: number;                    // highest matching wins
  config:
    | { adapter: 'cloud_agent'; repoUrl: string; startingRef: string; model?: string;
        promptTemplateId: string; autoCreatePR: boolean; maxDurationMinutes: number }
    | { adapter: 'automation_webhook'; webhookUrlSecretKey: string; automationId?: string };
  enabled: boolean;
};
```

Prompt templates are deliberately thin (D5). The default:

```
You are working on ticket {{ticket.key}} ({{ticket.id}}) at stage "{{stage.name}}".

Use the `nexus` MCP server for all context and all output:
  1. Call get_ticket and get_spec first. Do not assume anything not returned there.
  2. Do the stage's work as defined by your automation's own instructions and the repository's rules.
  3. If you are blocked on a human decision, call ask_question with blocking: true and stop.
  4. Before finishing, call post_stage_report exactly once. A run without a report is treated as a failure.

Run correlation nonce: {{run.nonce}} (include it if a tool asks for it).
```

Templates are versioned rows; a run records the template version it used, so a report can always be read against the instructions that produced it.

---

## 4. Data model changes

```sql
-- 0008_bindings.sql
create table prompt_templates (
  id uuid primary key, project_id uuid not null references projects(id),
  name text not null, version integer not null, body text not null,
  created_by_user_id uuid references users(id), created_at timestamptz not null default now(),
  unique (project_id, name, version)
);

create table automation_bindings (
  id uuid primary key,
  project_id uuid not null references projects(id),
  stage_id uuid not null references stages(id),
  name text not null,
  adapter text not null check (adapter in ('cloud_agent','automation_webhook')),
  condition jsonb,                          -- ConditionAst, null = always
  priority integer not null default 0,
  config jsonb not null,
  prompt_template_id uuid references prompt_templates(id),
  enabled boolean not null default true,
  archived_at timestamptz
);
create index bindings_lookup on automation_bindings (project_id, stage_id, enabled, priority desc);

-- 0009_runs.sql
create table runs (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  stage_instance_id uuid not null references stage_instances(id),
  binding_id uuid references automation_bindings(id),
  prompt_template_id uuid references prompt_templates(id),
  adapter text not null,
  trigger jsonb not null,                   -- { kind: 'manual'|'transition'|'resume'|'remediation', by }
  status text not null,                     -- see §3.4
  nonce text not null unique,
  provider_agent_id text,                   -- bc-…
  provider_run_id text,                     -- run-…
  provider_url text,                        -- cursor.com/agents/…
  model text,
  launched_at timestamptz, started_at timestamptz, terminal_at timestamptz,
  deadline_at timestamptz not null,
  duration_ms integer,
  tokens jsonb,                             -- {input,output,cacheWrite,cacheRead,total}
  usage_uuid text,                          -- join key for P4 reconciliation
  git_snapshot jsonb,                       -- best-effort, agent-scoped
  outcome text,                             -- from the report, when there is one
  error_code text, error_detail text,
  last_polled_at timestamptz, poll_attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index runs_active on runs (status, deadline_at) where status in ('pending','launched','running');
create unique index runs_one_active_per_item on runs (work_item_id)
  where status in ('pending','launched','running');

create table mcp_tokens (
  id uuid primary key,
  token_hash text not null unique, token_prefix text not null,
  run_id uuid references runs(id),
  work_item_id uuid not null references work_items(id),
  project_id uuid not null references projects(id),
  scopes text[] not null,
  expires_at timestamptz not null, revoked_at timestamptz,
  last_used_at timestamptz, use_count integer not null default 0
);

create table stage_reports (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  stage_instance_id uuid not null references stage_instances(id),
  run_id uuid not null references runs(id) unique,     -- one report per run
  outcome text not null, confidence numeric(3,2),
  headline text not null, summary text not null default '',
  assumptions jsonb not null default '[]', not_verified jsonb not null default '[]',
  raw jsonb not null,
  created_at timestamptz not null default now()
);

create table questions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  run_id uuid references runs(id),
  stage_instance_id uuid references stage_instances(id),
  text text not null, options jsonb not null default '[]',
  blocking boolean not null default false,
  status text not null default 'open' check (status in ('open','answered','withdrawn','superseded')),
  answer text, answered_by_user_id uuid references users(id), answered_at timestamptz,
  resume_run_id uuid references runs(id),               -- the run that carried the answer back
  created_at timestamptz not null default now()
);
create index questions_open on questions (work_item_id) where status = 'open';

create table artifact_refs (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  run_id uuid references runs(id),
  kind text not null, url text not null, title text,
  meta jsonb not null default '{}', created_at timestamptz not null default now()
);

create table mcp_call_log (
  id uuid primary key,
  token_id uuid references mcp_tokens(id), run_id uuid references runs(id),
  work_item_id uuid references work_items(id),
  tool text not null, ok boolean not null, error_code text,
  duration_ms integer, request_bytes integer, response_bytes integer,
  created_at timestamptz not null default now()
);
```

The partial unique index `runs_one_active_per_item` enforces "one active run per work item" in the database, which matters because Cursor enforces one active run per agent (`409 agent_busy`) and our concept of an item must not drift from that.

`work_items` gains `current_run_id uuid` and `last_report_id uuid` (denormalised for board rendering), and `stage_instances` gains `outcome` population from reports.

---

## 5. Interfaces

### 5.1 MCP tools

Contract lives in `packages/contracts/src/mcp/` and is published as human-readable documentation in `docs/mcp-contract.md`. Illustrative shapes:

```ts
get_ticket({ ticket_id }) -> {
  id, key, title, description, complexity, stage: { key, name, position },
  labels: [{ key, name, category }],
  owner_class, status,
  spec: { version, updated_at } | null,
  warnings: [],                       // populated from P3
  budget: null,                       // populated from P4
  links: { ui_url }
}

post_stage_report({ ticket_id, ...StageReport }) -> {
  report_id, already_posted: boolean,
  applied: { labels_added: string[], questions_created: number, artifacts: number },
  rejected: { labels_unknown: string[] }      // empty on success; the call fails if non-empty
}

ask_question({ ticket_id, text, blocking, options? }) -> { question_id, ticket_status }
```

### 5.2 Internal service surface

```ts
// packages/core/src/runs
resolveBinding(ctx, { workItemId, stageId }): Result<AutomationBinding, 'no_binding'>
launchRun(ctx, { workItemId, bindingId?, trigger }): Result<Run, LaunchError>
   // LaunchError: 'run_already_active' | 'no_binding' | 'orchestration_disabled'
   //            | 'provider_busy' | 'provider_error' | 'item_archived'
pollRun(ctx, runId): Result<Run>          // job handler
cancelRun(ctx, runId, reason): Result<Run>
   // Phase 0 observation: provider cancel may 500; map honestly, keep polling/deadline.
closeOutRun(ctx, runId): Result<Run>      // usage (+ cost fields), outcome, events, token revocation
```

### 5.3 UI additions to the ticket page

Progressive disclosure, exactly as `VISION.md` §7 asks:

```
┌ Stage: Scoping ──────────────────────── [Run stage ▸] ┐
│ ● Scoping run · completed · 4m 12s · 128k tokens      │
│   "Drafted spec; three open assumptions"      [Cursor]│  ← headline row
│   ▾ expand → outcome, confidence, summary, assumptions,│
│              not verified, labels set, artifacts       │
│ ○ Scoping run · failed · 38s · provider error   [Cursor]│
└───────────────────────────────────────────────────────┘
```

Runs append; nothing overwrites. A blocking question renders as a prominent answer form on the ticket (the ranked inbox is Phase 6, but the ticket must not hide it).

---

## 6. Implementation steps

### Step 2.1 — Freeze the contract

**Goal.** Write the contract down and get it reviewed **before** implementing it, because Phase 3 consumes stage reports and Phase 6 consumes questions.

**Changes.** `packages/contracts/src/mcp/*` with zod schemas for all nine tools; `docs/mcp-contract.md` with per-tool description, arguments, limits, error codes, and examples; the versioning policy; a golden-file test that fails if any schema changes without a version note.

**Done when.** The contract document is reviewed by whoever will author the companion automations, and their feedback is incorporated. This review is the point of the step — a contract nobody outside the team has read is not frozen.

---

### Step 2.2 — MCP server with real authentication

**Goal.** The nine tools, backed by Phase 1 services.

**Changes.** `apps/web/app/api/mcp/route.ts` (stateless streamable HTTP; fill the stub left after spike teardown); `packages/mcp/src/tools/*` — thin adapters calling core services with `Actor = { kind: 'agent', runId, workItemId }`; token verification with constant-time comparison, expiry, revocation, and scope checks; per-token rate limiting in Redis (default 120 calls/minute, 429 with `retryable: true`); `mcp_call_log` writes; payload caps enforced before parsing. Inject MCP headers per run as proven in ADR-0004 (`Authorization` + `x-vercel-protection-bypass`).

**Done when.** Contract tests pass for every tool, including refusals: wrong ticket, expired token, revoked token, unknown label, oversize payload, second report. An MCP client outside Vercel completes a full read/write cycle against the preview deployment.

---

### Step 2.3 — Bindings and prompt templates

**Goal.** Configuration a human can create in the UI.

**Changes.** Binding and template CRUD services; resolution (`stage` + optional label/complexity filters + priority; Phase 3 upgrades `condition` to the full DSL); project settings UI for bindings, with a "test resolve" affordance that shows which binding a given work item would select and why; the webhook URL stored as a **secret key reference**, never a value in the database.

**Done when.** A project can bind an automation to Scoping, and "test resolve" explains the choice for three differently-labelled items.

---

### Step 2.4 — The launcher

**Goal.** One well-guarded path from intent to a running agent.

**Changes.** `launchRun` with: advisory lock on the work item; pre-flight checks; run row and nonce written **before** the provider call (so a provider timeout still leaves a record); token minting; deterministic `agentId` derived from `(workItemId, stageInstanceId, bindingId, attempt)` for idempotent creates (D17); adapter dispatch; provider error mapping — `409 agent_busy` → `provider_busy`, `409 agent_id_conflict` → adopt the existing agent rather than creating another; the global `orchestration.enabled` kill switch; a per-project concurrent-run ceiling.

**Done when.** A "Run stage" click produces a running agent; a double click produces one run and a clear message; killing the switch prevents all launches; a simulated provider timeout leaves a `launch_failed` run, never a phantom agent.

---

### Step 2.5 — The observer

**Goal.** No run is ever silently lost.

**Changes.** `poll_run` job with adaptive backoff and deadline; terminal handling; usage fetch (tokens + `chargedCents` when present); `git_snapshot` capture; the stuck watchdog (`sweep_stuck_runs`, hourly) that **does not depend on cancel succeeding**; close-out — revoke the token, set `outcome`, decide `completed` vs `completed_no_report`, update the stage instance, emit `run.finished` / `run.failed` / `run.completed_without_report`.

**Done when.** Every row in the Phase 0 failure matrix (ADR-0005) reaches a correct terminal state within one poll interval of the truth, including the cron-gap case and the live-proven no-MCP case, and no run remains active past its deadline.

---

### Step 2.6 — Report ingestion and its side effects

**Goal.** One transaction that turns a report into system state.

**Changes.** `postStageReport` writing report, labels (validated against the taxonomy and `agent_settable`), questions, artifact refs; `outcome: 'blocked'` plus a blocking question sets the derived status to `needs_answer`; `deriveStatus` gains its Phase 2 inputs; events emitted per artefact created.

**Done when.** A report with two labels, one blocking question, and a PR reference produces exactly those effects atomically; an invalid label rejects the whole call with a message naming it; a duplicate post returns the original.

---

### Step 2.7 — Ticket and board UI for agent work

**Goal.** A human can see what the agent did without leaving the ticket, and can get to Cursor in one click.

**Changes.** Run timeline with progressive disclosure; report renderer (sanitised markdown, assumptions and not-verified as distinct callouts); live run indicator via the SSE proxy with polling fallback; question answer form; artifact reference list; board cards showing "AI working" with elapsed time; `Run stage` and `Cancel run` actions with permission checks (**Phase 0 observation:** Cancel must show provider failure if cancel 500s; the run continues to be observed until terminal or deadline).

**Done when.** The Phase 2 proof renders correctly, including two runs on one ticket appending in order, and a failed run reading as failed rather than as an absence.

---

### Step 2.8 — Questions captured (routing deferred)

**Goal.** Blocking questions are unmissable on the ticket and answerable, without pretending Phase 6 exists.

**Changes.** Question service (create/answer/withdraw/supersede); answering enqueues a **resume**: a follow-up run on the same agent (`POST /v1/agents/{id}/runs`) carrying the answer, falling back to a fresh agent when the original is archived, expired, or busy; the resume run links to the question via `resume_run_id`; a project-level list of open questions as a stopgap surface.

**Done when.** Answering a blocking question resumes the agent, the resumed run posts a second report, and the ticket shows the question, the answer, and the run that carried it.

---

### Step 2.9 — The companion automation and the integration guide

**Goal.** Close the external dependency that `Implementation Phases.md` calls the most underestimated in the plan.

**Changes.** A hand-authored **scoping automation** in Cursor: reads the ticket and spec through MCP, drafts a spec via `update_spec`, sets labels, posts a report, and asks a blocking question when the input is too thin. Plus `docs/authoring-automations.md`: what an automation must do to work with Nexus, the report contract, the failure modes, and a copy-pasteable prompt skeleton. Plus a **deliberately failing** automation for the demo.

**Done when.** Someone who has not read this codebase can wire a new automation to a stage using only the guide, and the scoping automation completes the proof scenario twice in a row.

---

### Step 2.10 — Hardening and drift protection

**Goal.** The contract stays trustworthy after the phase closes.

**Changes.** Nightly live smoke test against the real Cursor API (create a no-repo agent, read `/v1/models`, assert the client's fixtures still match) that alerts on drift; MCP call metrics on `/api/health`; a runbook section for "a run is stuck", "an agent cannot reach MCP", "reports are rejected"; flag removal.

**Done when.** The nightly job has caught at least one intentional fixture mismatch in a test run, and the runbook has been walked by someone other than its author.

---

## 7. Testing and verification

- **Contract tests** for all nine tools: happy path, every documented error, limits, idempotency, authorisation. These run on every PR forever; they are the regression suite for the surface we promised not to break.
- **Integration tests** with a fake provider implementing the Cloud Agents API's documented semantics — including `409 agent_busy`, `409 agent_id_conflict`, delayed usage, and terminal-without-report. Every lifecycle path in §3.4 is asserted.
- **Job tests:** poller idempotency (running a poll twice does not double-close), deadline enforcement, backoff schedule.
- **Security tests:** token for ticket A refused on ticket B; revoked token refused; MCP endpoint unreachable without the bypass header; no run token ever appears in logs or events.
- **End-to-end** against the preview deployment with a real agent, run nightly rather than per-PR (it costs money and takes minutes).
- **Load sanity:** 20 concurrent active runs polled within a single cron tick without exceeding the function time limit.

## 8. Rollout and safety

- Flags: `p2.mcp`, `p2.bindings`, `p2.runs`, each enabled per project.
- **Spend controls before budgets exist (Phase 4 is two phases away):** per-project concurrent run ceiling, per-project daily run count cap, per-run duration deadline, and the global kill switch. Crude, deliberate, and removable once real budgets land.
- Run tokens: 90-minute default TTL, revoked at terminal, never logged, displayed nowhere.
- MCP writes are authorised as the agent actor, and the actor is stored on every artefact so a later "what did the AI change" query is trivial.
- Rollback: disabling `p2.runs` stops new launches while leaving existing runs to be observed to completion.

## 9. Demo script (the proof)

1. **One line in.** Create "Users should be able to export their data as CSV" in Alpha at Intake, with no spec.
2. **Bind and run.** Show the Scoping binding in settings, then click **Run stage**. The run appears immediately as `launched` with a Cursor link.
3. **Watch it work.** Open the Cursor run alongside; show the agent calling `get_ticket`, `get_spec`, `update_spec`, `set_labels`, `post_stage_report`.
4. **Back in Nexus.** The spec now has a version authored by the agent. The report shows at headline level; expand it for assumptions, not-verified, and the labels it set. Duration and token usage are shown. The Cursor link works.
5. **Append, don't overwrite.** Run the stage again. Two runs, two reports, in order, spec at version 3 — nothing lost.
6. **Ask and answer.** Show a run that ends with a blocking question; the ticket reads `Needs answer`. Answer it; a resume run starts, and its report closes the loop.
7. **Fail on purpose.** Run the failing automation. Show it terminal as `failed`, with the error visible and the ticket not stuck. Then show a `completed_no_report` run — provider says finished, nothing arrived — and explain why that is a distinct state.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| The contract changes after agents depend on it | A "small tweak" PR to a tool schema | Version the contract, keep golden-file tests, and require an ADR for any breaking change |
| Companion automations never materialise | Step 2.9 slips repeatedly | Build the minimal scoping automation inside the team; treat richer ones as a stretch |
| Silent success — a run finishes having done nothing | Tickets advance with empty reports | `completed_no_report` is a first-class terminal state (**Phase 0 live-proven**), surfaced on the ticket and, in Phase 6, in the inbox |
| Runaway spend before budgets exist | Daily run count climbs unexpectedly | Concurrency ceiling, daily cap, deadlines, kill switch, and a daily spend digest to the team channel |
| Cursor beta API drift | Fixture tests pass but live calls fail | Nightly live smoke test with alerting |
| Agents rewrite specs destructively | A spec version loses content the human wrote | Versions are append-only; `update_spec` supports merge semantics and `base_version` conflict detection; the UI diffs every version |
| Correlation ambiguity on the webhook adapter | Reports arrive with nonces we cannot match | Nonce is mandatory in that adapter's prompt; unmatched reports are quarantined and surfaced rather than dropped. **Phase 0:** webhook adapter unproven until Q4 |
| One active run per agent conflicts with our model | Frequent `409 agent_busy` | The database enforces one active run per work item, so our model cannot exceed the provider's (**Phase 0:** `409 agent_busy` confirmed) |
| Cancel used as recovery | Operator believes a run stopped when it did not | **Phase 0 observation:** treat cancel as best-effort; deadline + poll are authoritative |

## 11. Exit criteria

- [ ] `docs/mcp-contract.md` is published, reviewed externally, and version-tagged.
- [ ] All nine tools work against a deployed environment with per-run scoped tokens.
- [ ] A stage can be bound to an automation and launched with a ticket identifier only.
- [ ] Every run reaches a recorded terminal state with duration, token usage, and outcome — including cancelled, expired, failed, and `completed_no_report`.
- [ ] Reports append; a second run never overwrites the first.
- [ ] Agent-set labels are validated against the project taxonomy and honoured (Phase 3 will gate on them).
- [ ] A blocking question stops the ticket, and answering it resumes the work.
- [ ] The Cursor run link works from every run row.
- [ ] The failure demo shows a failed run as failed, not as a stuck ticket.
- [ ] `docs/authoring-automations.md` is complete enough for an outsider to wire a new automation.
- [ ] Spend controls (ceiling, daily cap, deadline, kill switch) are active.

## 12. Open questions for this phase

- **Q4** — who owns the companion automations beyond the PoC. Step 2.9 covers the demo; ownership afterwards is unresolved. **Phase 0 observation:** no Nexus webhook automation exists yet — Q4 also blocks Spike B / webhook-adapter proof.
- **Q5** — whether the per-binding prompt template is acceptable, or whether we go webhook-only (D5). **Phase 0 observation:** D5 confirmed for the API path with live MCP; webhook-only is not forced. Prefer API + thin prompt; keep webhook as secondary when Q4 lands.
- **Local:** should a transition into a stage auto-launch its binding, or must a human click Run? Recommendation: manual in Phase 2, add an opt-in `auto_run_on_entry` per binding in Phase 3 once gates can stop a bad auto-launch.
- **Local:** how long do we retain `mcp_call_log`? Recommendation: 30 days, then aggregate — it grows fastest of any table here.
