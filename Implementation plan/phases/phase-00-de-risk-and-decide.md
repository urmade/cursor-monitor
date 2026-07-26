# Phase 0 — De-risk and decide

> **Outcome.** "The unknowns that could invalidate the architecture are closed with evidence rather than assumption. We know how we start a Cursor Automation, how we observe it, how the agent reaches back to us, and what our identity and access model is. A throwaway walking skeleton exists end to end with no UI and no persistence beyond the minimum."
>
> **Proof.** A hardcoded ticket identifier triggers a real Cursor Automation in a real repository; the automation reaches our MCP endpoint, reads something, writes something back; we observe the run reaching a terminal state and record its duration and token usage. Demonstrated live, twice, including one failure case.
>
> **Milestone.** M1 — Loop proven. **Depends on.** Nothing in this repo; everything external (see §2). **Unblocks.** Every other phase.

---

## 1. Objective and scope

Phase 0 buys information, not features. It ends with a written decision record and a demonstrated loop, and most of the code it produces is deleted.

Three questions must be answered with evidence:

1. **Can we start agentic work?** Which invocation path do we use — the Cloud Agents v1 API or an automation's webhook trigger — and what do we get back at launch that lets us correlate the run to a ticket?
2. **Can we observe it?** How do we learn that a run finished, failed, or hung; how long it took; and how many tokens it burned — given that v1 webhooks do not exist yet and Vercel cannot hold a long-lived SSE connection.
3. **Can the agent reach us?** Can a Cursor cloud agent make an authenticated MCP call into a Passport-protected Vercel deployment, and read and write real data.

A fourth, quieter question runs alongside: **does this platform host this shape of application at all?** A pnpm monorepo behind `vercel.root_directory`, with cron and a database, deployed only through PR previews. That is the first step, because everything else is built on it.

### In scope

- A deployable monorepo skeleton with a health endpoint, database connectivity, and a working cron tick.
- A minimal but honest MCP endpoint: real HTTP transport, real bearer auth, two tools, backed by one Postgres table.
- Two invocation spikes (direct API and automation webhook), executed against a real repository.
- A failure-mode matrix produced by deliberately breaking things.
- A usage and cost feasibility check against both the Cloud Agents usage endpoint and the Admin API.
- ADRs recording every decision, and the deletion of everything not worth keeping.

### Out of scope

| Not in Phase 0 | Lands in |
|---|---|
| Any product schema (projects, work items, specs) | Phase 1 |
| Any UI beyond a health page | Phase 1 |
| The real MCP contract | Phase 2 |
| Binding automations to stages | Phase 2 |
| Gates, budgets, attention | Phases 3, 4, 6 |

**The Phase 0 code is disposable and must be labelled as such.** Everything the spike writes lives under a `spike/` path or behind the `p0.spike` flag, and step 0.9 removes it. The only survivors are the deployment skeleton, the `cursor-client` sketch, and the ADRs.

---

## 2. Preconditions

| Precondition | Source | Blocking |
|---|---|---|
| Cursor API key with Cloud Agents access (service account preferred) | Cursor team admin — `open-questions.md` Q1 | Yes, from step 0.4 |
| Team-scoped Admin API key (Enterprise) | Cursor team admin — Q1 | Step 0.7 only |
| Protection Bypass for Automation on the `nexus` Vercel project | `#proj-internalsphere` — Q2 | Yes, from step 0.3 |
| A repository cloud agents may run in | Project owner — Q3 | Yes, from step 0.4 |
| One hand-authored automation with a webhook trigger | Whoever owns automations — Q4 | Step 0.5 only |

Request the bypass and the service account **before** writing any code; they have the longest lead time and nothing after step 0.2 works without them.

---

## 3. Technical approach

The spike is arranged so each step produces evidence that survives even if the next step fails.

```
0.1 skeleton deploys ──► 0.2 credentials land ──► 0.3 agents can call us
                                                        │
                        ┌───────────────────────────────┴───────────────┐
                        ▼                                               ▼
              0.4 direct API invoke                        0.5 automation webhook invoke
                        └───────────────┬───────────────────────────────┘
                                        ▼
                        0.6 failure matrix ──► 0.7 usage & cost ──► 0.8 identity ──► 0.9 decide
```

The **walking skeleton** is deliberately thin: one table, two MCP tools, one poller invoked by cron. It exists to make the loop real, not to prototype the product.

```
Spike runner (a REST endpoint we curl)
   └─► cursor-client.createAgent({ prompt, repos, mcpServers: [nexus with run token] })
          └─► Cursor cloud agent
                 ├─► GET  nexus /api/mcp  → tool: spike_get_ticket   → reads spike_tickets row
                 └─► POST nexus /api/mcp  → tool: spike_post_report  → writes spike_reports row
   └─► cron tick every minute → poll GET /v1/agents/{id}/runs/{runId} → record status, durationMs
   └─► on terminal → GET /v1/agents/{id}/usage?runId=… → record token counts
```

---

## 4. Data model changes

One migration, `0001_spike.sql`, containing only what the spike needs. It is dropped in step 0.9.

```sql
create table spike_tickets (
  id            uuid primary key,
  title         text        not null,
  body          text        not null default '',
  labels        text[]      not null default '{}',
  created_at    timestamptz not null default now()
);

create table spike_runs (
  id               uuid primary key,
  ticket_id        uuid        not null references spike_tickets(id),
  adapter          text        not null check (adapter in ('cloud_agent','automation_webhook')),
  external_agent_id text,
  external_run_id  text,
  nonce            text        not null,
  status           text        not null,
  launched_at      timestamptz not null default now(),
  terminal_at      timestamptz,
  duration_ms      integer,
  tokens           jsonb,
  raw_last_poll    jsonb,
  error            text
);

create table spike_reports (
  id          uuid primary key,
  ticket_id   uuid        not null references spike_tickets(id),
  run_nonce   text,
  body        jsonb       not null,
  created_at  timestamptz not null default now()
);

create table spike_run_tokens (
  token_hash  text primary key,
  run_id      uuid        not null references spike_runs(id),
  ticket_id   uuid        not null references spike_tickets(id),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
```

The shape of these four tables is a rehearsal for `work_items`, `runs`, `stage_reports`, and `mcp_tokens` in Phases 1 and 2. Getting the columns roughly right here means Phase 2 confirms a design rather than inventing one.

---

## 5. Interfaces

### 5.1 Spike MCP tools

```ts
// packages/mcp/src/spike-tools.ts
spike_get_ticket({ ticket_id: string })
  -> { id, title, body, labels, nonce_expected: string }

spike_post_report({ ticket_id: string, nonce: string, outcome: 'complete'|'partial'|'failed',
                    headline: string, summary?: string, labels_to_set?: string[] })
  -> { ok: true, report_id: string }
```

Both are authenticated with `Authorization: Bearer <run token>`; the token's `ticket_id` must match the argument, otherwise the tool returns an MCP error (not an exception) so we can see how an agent reacts to a refusal.

### 5.2 Spike control endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/spike/launch` | Body `{ ticketId, adapter }` — mints a run token, launches, returns run row |
| `GET /api/spike/runs/:id` | Current recorded state of a run |
| `POST /api/spike/cancel/:id` | Cancel via the API, to observe what cancellation looks like |
| `GET /api/cron/tick` | Cron entry point; polls active runs |
| `GET /api/health` | DB connectivity, migration version, last cron tick |

All are behind the `p0.spike` flag and require a static admin bearer token; none survive Phase 0.

---

## 6. Implementation steps

### Step 0.1 — Monorepo skeleton that actually deploys

**Goal.** Prove the layout in `architecture-baseline.md` §2 builds and serves on a Vercel preview before any product code exists. This is the highest-value cheap step in the plan: the "green deploy, 404 page" failure mode is the most common on this platform and it is a configuration problem, not a code problem.

**Changes.**

- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc` at the root; scripts `lint`, `typecheck`, `test`, `build`, `db:exec-migrations`.
- `apps/web` — Next.js App Router, TypeScript strict, Tailwind, a landing page and `app/api/health/route.ts`.
- `apps/web/vercel.json` — `{ "framework": "nextjs", "crons": [{ "path": "/api/cron/tick", "schedule": "* * * * *" }] }`.
- `app-manifest.yml` — add `vercel.root_directory: apps/web` (one PR, wait for orchestrator reconciliation).
- `packages/config` — shared `tsconfig`, ESLint (including the import-boundaries rule from `architecture-baseline.md` §2), Prettier, Vitest preset.
- `docker-compose.yml` — Postgres and Redis for local work.
- `CONTRIBUTING.md` — how to run locally, why `vercel dev` is unavailable, how to add a secret.

**Watch for.** Build logs running `next build` at the repository root instead of `apps/web` means the manifest change has not reconciled yet — wait, do not fight it with `vercel.json`. Confirm the canonical preview hostname from the `internalsphere-ranger` comment rather than guessing.

**Done when.** A PR preview URL serves the landing page and `/api/health` returns 200 with a build SHA, and the cron entry appears in the Vercel project's cron list (answers Q7).

---

### Step 0.2 — Credentials, integrations, and the bypass

**Goal.** Everything the spike needs is provisioned and reachable, with nothing in plaintext.

**Changes.**

- `app-manifest.yml` — add `integrations.db.type: supabase`. Merge, then confirm `DB_POSTGRES_*` and `DB_SUPABASE_*` appear on the Vercel project.
- Secrets added via `python3 scripts/secrets.py add --scope shared --key …`:
  - `CURSOR_API_KEY` (Cloud Agents), `CURSOR_ADMIN_API_KEY` (Admin API, may be production-scope only),
  - `SPIKE_ADMIN_TOKEN`, `MCP_TOKEN_SIGNING_KEY`, `CRON_SECRET`,
  - `VERCEL_PROTECTION_BYPASS` (the value issued by `#proj-internalsphere`).
- `packages/db` — connection factory (pooled at runtime, direct for migrations), the `exec-migrations` script wired into the root `db:exec-migrations`, and migration `0001_spike.sql`.
- `/api/health` extended to report database connectivity and applied migration version.

**Done when.** The preview deploy runs migrations in CI, `/api/health` reports the database as reachable, and a `curl` with the bypass header reaches a deployed endpoint that Passport would otherwise block. **If the bypass is not yet granted, stop here** — steps 0.3 onward cannot be faked.

---

### Step 0.3 — Minimal MCP endpoint an external agent can actually call

**Goal.** A remote MCP server on the deployment, authenticated, with two working tools.

**Changes.**

- `apps/web/app/api/mcp/route.ts` — streamable HTTP MCP handler, stateless (no server-side session state; serverless functions do not survive between calls).
- `packages/mcp/src/spike-tools.ts` — the two tools from §5.1, with zod-validated inputs and a strict payload size cap.
- `packages/core/src/spike/tokens.ts` — mint (random 32 bytes, store SHA-256, return `nexus_rt_<prefix>.<secret>`), verify, revoke.
- Structured logging of every MCP call: tool name, token prefix, ticket id, duration, outcome.

**Verification before involving an agent.** Drive the endpoint with a local MCP client script (`pnpm spike:mcp-client`) over the public preview URL with both headers set. Confirm: a valid token reads a ticket; a token for a different ticket is refused; an expired token is refused; an oversized payload is rejected.

**Done when.** A machine outside Vercel completes both tool calls against the preview deployment, and the refusal cases behave as designed.

---

### Step 0.4 — Spike A: invoke and observe through the Cloud Agents API

**Goal.** The primary invocation path, end to end, with correlation and observation.

**Changes.**

- `packages/cursor-client/src/` — typed client for `POST /v1/agents`, `POST /v1/agents/{id}/runs`, `GET /v1/agents/{id}/runs/{runId}`, `POST …/cancel`, `GET /v1/agents/{id}/usage`, `GET /v1/models`. Bearer auth, timeouts, retry with backoff on 5xx and 429, typed error mapping for `409 agent_busy` and `409 agent_id_conflict`.
- `packages/core/src/spike/launch.ts` — mint run token, build prompt, create the agent.
- `packages/jobs/src/handlers/spike-poll-run.ts` + cron wiring — adaptive polling, terminal detection, usage fetch, persistence.

**Launch shape to validate.**

```ts
await cursor.createAgent({
  agentId: `bc-${uuidv7()}`,                       // client-supplied → idempotent create
  prompt: { text: renderSpikePrompt({ ticketId, nonce }) },
  repos: [{ url: SANDBOX_REPO, startingRef: 'main' }],
  autoCreatePR: false,
  mcpServers: [{
    name: 'nexus',
    type: 'http',
    url: `${DEPLOYMENT_URL}/api/mcp`,
    headers: {
      Authorization: `Bearer ${runToken}`,
      'x-vercel-protection-bypass': process.env.VERCEL_PROTECTION_BYPASS!,
    },
  }],
});
```

**Questions this step must answer, written into the spike report:**

1. Does the agent discover and call an injected MCP server without repository-side configuration?
2. Are both headers forwarded intact (does the bypass header survive)?
3. What is the latency from create to first MCP call, and to terminal?
4. Does re-POSTing the same `agentId` reliably return `409 agent_id_conflict`?
5. What exactly does `GET …/runs/{runId}` return at each status, and how does `git.branches[]` behave across two runs on the same agent?
6. Does `GET /v1/agents/{id}/usage` populate promptly at terminal, or lag?

**Done when.** A launch from `POST /api/spike/launch` results in a `spike_reports` row written by a real agent, and the run reaches a terminal state in our database with a duration and token counts, without anyone touching the Cursor UI.

---

### Step 0.5 — Spike B: invoke through an automation webhook

**Goal.** Establish what the automation path can and cannot give us, so D5 is decided on evidence rather than preference.

**Changes.**

- `packages/cursor-client/src/automation-webhook.ts` — POST to the automation's webhook URL with `Authorization: Bearer <automation key>` and body `{ ticket_id, nonce, stage, mcp_url }`.
- A hand-authored automation configured with our MCP server and a prompt instructing it to read the ticket and post a report echoing the nonce.
- `packages/core/src/spike/correlate.ts` — match an inbound report's nonce to a `spike_runs` row; separately, attempt to discover the agent via `GET /v1/agents` filtered by recency and service-account identity.

**Questions this step must answer:**

1. Does the webhook response contain any identifier we can correlate on, or is the nonce our only handle?
2. How long between POST and the agent's first MCP call?
3. Can an automation's MCP configuration accept a per-invocation token, or must it be static? (Expected: static — confirm.)
4. Can we find the resulting agent through `GET /v1/agents` well enough to poll it, and how ambiguous does that get with two concurrent invocations?
5. Does the Admin API attribute usage to `automationId` as documented?

**Done when.** An automation-triggered agent posts a report we can correlate, and the answers above are written up — including, if it is the case, "we cannot reliably observe this path", which is itself a decisive result.

---

### Step 0.6 — Break it on purpose

**Goal.** A failure-mode matrix. `Implementation Phases.md` requires the Phase 0 demo to include a failure case; this step produces several so the demo can pick the most instructive.

**Scenarios to run and record** (observed behaviour, our detection mechanism, and the recovery we would need to build):

| # | Scenario | What we need to learn |
|---|---|---|
| 1 | MCP endpoint returns 500 during a tool call | Does the agent retry, work around it, or fail the run? |
| 2 | Run token expires mid-run | Does the agent surface the refusal or silently continue? |
| 3 | Agent never calls MCP at all | How do we distinguish "finished without doing the work" from success? |
| 4 | Cancel a running run | Terminal status, timing, and whether usage is still reported |
| 5 | Second run started while one is active | Confirm `409 agent_busy` and decide queue-vs-reject |
| 6 | Poller misses the terminal transition (cron gap) | Does a later poll still return terminal state, or does data expire? |
| 7 | SSE stream requested after its retention window | Confirm `410 stream_expired` and the fallback to `GET run` |
| 8 | Bypass header omitted | Confirm the request is blocked at the edge, i.e. the protection is real |
| 9 | Agent posts a malformed report | Confirm zod rejection produces an MCP error the agent can act on |
| 10 | Cursor API returns 429 | Confirm the client's backoff and whether launches should queue |

**Done when.** `docs/decisions/ADR-0005-failure-modes.md` contains the matrix, and the run-state machine sketched for Phase 2 covers every observed terminal and stuck state, including "finished but nothing was posted".

---

### Step 0.7 — Usage, cost, and reconciliation feasibility

**Goal.** Know now, not in Phase 4, whether real money numbers are available.

**Changes.**

- `packages/cursor-client/src/admin.ts` — `POST /teams/filtered-usage-events` with `cloudAgentId` and `automationId` filters.
- A one-off script that, for each spike run, compares: token counts from `GET /v1/agents/{id}/usage`, our estimate from a draft price table, and `chargedCents` from the Admin API.

**Questions.** Does our plan tier return `chargedCents`? How long after a run do events appear (hourly aggregation is documented)? Does `cloudAgentId` join cleanly to our recorded agent id? Do automation-triggered runs carry `automationId` as expected? What is the observed gap between estimate and reconciled charge?

**Done when.** A short table of runs with estimated versus reconciled cost exists, and Phase 4's dependency "plan tier that exposes reconciled charges" is answered yes or no in writing.

---

### Step 0.8 — Identity and access model, decided and demonstrated

**Goal.** Close `VISION.md` §17.7 with running code, not a paragraph.

**Changes.**

- `apps/web/src/server/identity.ts` — Passport token parsing per `architecture-baseline.md` §6.1, with the guarded local fallback.
- A `/spike/whoami` page that renders the `external_sub`, and whatever profile claims are actually present on this deployment.
- `docs/decisions/ADR-0006-identity-and-access.md` — the role matrix, the two machine-token families, and where authorisation is enforced.

**Done when.** Opening the preview URL in a browser shows a stable user identity derived from Passport, a `curl` without Passport is rejected by the edge, and a `curl` with the bypass but no bearer token is rejected by us.

---

### Step 0.9 — Decide, record, and tear down

**Goal.** Convert the evidence into decisions and leave the repository clean.

**Changes.**

- ADRs in `docs/decisions/`: `0001-stack` (pinned versions), `0002-invocation-path` (confirms or overturns D5), `0003-observation-strategy` (confirms or overturns D7), `0004-mcp-auth` (confirms D6), `0005-failure-modes`, `0006-identity-and-access`, `0007-cost-data-availability`.
- Update `decisions.md` and `open-questions.md` in this folder to reflect the answers.
- Delete the spike: `0002_drop_spike.sql`, remove `/api/spike/*`, spike tools, and the `p0.spike` flag. **Keep** the deployment skeleton, `packages/db` plumbing, `packages/jobs` scaffolding, `packages/cursor-client`, the identity module, and the MCP route file (emptied to a stub that Phase 2 fills in).
- A one-page spike report in `docs/decisions/phase-0-report.md`: what we proved, what surprised us, what Phase 2 must design around.
- Amend later-phase plans where Phase 0 evidence contradicts them: `architecture-baseline.md`, `phase-01-system-of-record.md`, `phase-02-agent-loop.md`, `phase-04-economics.md` — each with an explicit **Phase 0 observations** annotation.

**Done when.** `main` contains no `spike_*` tables or routes, the ADRs are merged, and the Phase 1/2/4 plans plus architecture baseline have been re-read against the findings and amended where they contradict it.

---

## 7. Testing and verification

Phase 0 is verified by observation, not by a test suite — but three things get real tests because they survive the phase:

- `packages/cursor-client` — unit tests against recorded fixtures for each endpoint, including the two `409` shapes and the `410` stream expiry.
- Run-token mint/verify/revoke — unit tests including expiry and cross-ticket refusal.
- `/api/health` — an integration test asserting it fails loudly when the database is unreachable.

Everything else is captured as evidence: request/response transcripts (secrets redacted) committed under `docs/decisions/evidence/`, plus a screen recording of the demo.

## 8. Rollout and safety

- All spike endpoints require `SPIKE_ADMIN_TOKEN` and are behind `p0.spike`, off in production.
- Agent launches during the spike use a sandbox repository with `autoCreatePR: false`.
- Set a hard cap on spike runs (a counter checked before launch) so a loop cannot burn budget unattended.
- The bypass secret is used only in server-side code and never rendered into a page or logged.

## 9. Demo script (the proof)

Two live runs, roughly fifteen minutes.

**Run 1 — the happy path.**
1. Show `spike_tickets` containing one row, and `spike_reports` empty.
2. `POST /api/spike/launch` with that ticket id. Show the returned agent id and run id, and the `cursor.com/agents/...` link.
3. Open the Cursor run in a browser; show the agent calling the `nexus` MCP tools.
4. Back in our database: the report row the agent wrote, and the run row moving through statuses as the cron poller updates it.
5. At terminal: duration, token counts, and the estimated cost from the draft price table.

**Run 2 — a failure.** Choose from the matrix; scenario 3 ("agent never calls MCP") is the most instructive because it is the one a naive implementation would report as success. Show the run reaching terminal, our detection that no report arrived, and the run recorded as `completed_without_report` rather than success.

**Close.** Walk the decision record: which invocation path, which observation strategy, whether reconciled costs are available, and what the identity model is.

## 10. Risks and mitigations

| Risk | Signal it is happening | Mitigation |
|---|---|---|
| Protection bypass is refused or slow | No answer in `#proj-internalsphere` within a few days | Escalate immediately; there is no in-platform workaround and the whole plan stalls |
| Injected `mcpServers` headers are stripped or ignored | Agent reports it cannot reach the MCP server | Fall back to the automation path with a static project token (D5 adapter B); scoping weakens but the loop survives |
| Cloud Agents v1 beta changes under us | A previously working call starts returning 4xx | Pin behaviour in `cursor-client` with fixture tests; add the nightly live smoke test in Phase 2 |
| Monorepo root directory misconfiguration | Build logs install at the repo root; preview 404s | Step 0.1 exists to find this on day one, before any code depends on it |
| Cron granularity is coarser than expected | Cron list shows a different schedule than requested | Self-triggering job chain as fallback (Q7) |
| Admin API does not expose `chargedCents` on our tier | Empty or 403 response in step 0.7 | Ship estimate-only costs in Phase 4 and label them honestly in the UI |
| Spike code becomes the product | Phase 1 starts before step 0.9 is merged | Teardown is a step, not a suggestion; Phase 1's first PR should not merge until the spike tables are dropped |

## 11. Exit criteria

- [ ] A PR preview deploys the monorepo, serves `/api/health`, and runs a cron tick.
- [ ] Supabase Postgres is provisioned, migrations run in CI, and the app reads and writes.
- [ ] A Cursor cloud agent has read and written data through our MCP endpoint on a deployed environment.
- [ ] A run has been launched, observed to terminal, and recorded with duration and token counts, twice, without manual intervention.
- [ ] Both invocation adapters have been tried, and the primary path is chosen in an ADR with reasons.
- [ ] The failure matrix (§6, step 0.6) is complete, with a detection mechanism named for every row.
- [ ] Estimated versus reconciled cost has been compared for at least one run, or the absence of reconciled data is documented.
- [ ] The identity and access model is demonstrated and written down.
- [ ] The spike is deleted; `main` is clean.
- [x] Phase 1 and Phase 2 plans have been reviewed against the findings and amended where contradicted. (**Phase 0 observation follow-up:** also amended `architecture-baseline.md` and `phase-04-economics.md`; see those docs' "Phase 0 observations" sections.)

## 12. Open questions for this phase

Q1 (service account and plan tier), Q2 (protection bypass), Q3 (sandbox repository), Q6 (what CI runs), Q7 (cron granularity) — all in [`open-questions.md`](./open-questions.md). Q2 is the one to chase first.
