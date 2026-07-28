# Phase 8 — Openness

> **Outcome.** "The system is as operable by machines as by people. Outbound events for ticket, stage, run, gate, and question activity are published reliably with visibility into delivery. A public interface covers the core objects so external tooling can read and drive the system."
>
> **Proof.** An external endpoint receives events for a full ticket lifecycle. A deliberately failing endpoint shows failed deliveries with their reasons and can be replayed after being fixed. An external script creates a ticket, sets complexity, and reads its state through to Deploy.
>
> **Depends on.** Phases 1 through 5 for the events worth publishing. Otherwise independent — the most parallelisable phase in the plan, and it can run alongside Phases 5 through 7. **Unblocks.** Adjacent tooling, and later third-party sync from the expansion backlog.

---

## 1. Objective and scope

Phase 8 is mostly harvest. The outbox has been filling since Phase 1 (D13) and every mutation already goes through a core service, so this phase adds two adapters and the operational surface around them — it does not touch domain logic.

What it does introduce is a **promise**. Once an external system consumes our events or our API, changing them breaks someone. So the phase's real work is deciding what to promise, saying so explicitly, and building the machinery to keep the promise: signing, retries, visibility, replay, versioning, and deprecation.

### In scope

The published event catalogue with frozen payload schemas; webhook endpoint registration with HMAC signing; the delivery worker with retries, backoff, and a dead-letter path; the delivery inspector with replay; the public REST API v1 over the core objects; API tokens with scopes; rate limiting and idempotency; OpenAPI documentation and working examples.

### Out of scope

| Not in Phase 8 | Lands in |
|---|---|
| Third-party project management sync (Jira, Linear, GitHub Issues) | Expansion backlog (`VISION.md` §14) |
| Inbound webhooks from other systems | Not planned for the PoC |
| GraphQL or a realtime subscription API | Not planned |
| A published SDK package | Snippets only; a real SDK is post-PoC |
| Public API access to gate *configuration* (read is offered, write is not) | Deliberate — policy stays in the UI for the PoC |

---

## 2. Preconditions

- Phases 1–5 complete, so the event catalogue covers a full lifecycle. Publishing events for half a lifecycle teaches consumers a shape we will then have to change.
- A decision on API surface breadth: **read broad, write narrow** (see §3.4).
- Phase 2's token infrastructure, which API tokens extend rather than duplicate.

---

## 3. Technical approach

### 3.1 The event catalogue

The internal `events` table has been accumulating since Phase 1. Not all of it should be public: internal bookkeeping (`cost.rollup_recomputed`, `attention.reconciled`) has no external meaning and would lock us into implementation details.

Publication is therefore explicit — an allow-list, not a filter:

```ts
// packages/contracts/src/events/catalog.ts
export const PUBLIC_EVENTS = {
  'work_item.created':        { version: 1, schema: WorkItemCreatedV1 },
  'work_item.updated':        { version: 1, schema: WorkItemUpdatedV1 },
  'work_item.stage_changed':  { version: 1, schema: StageChangedV1 },
  'work_item.status_changed': { version: 1, schema: StatusChangedV1 },
  'spec.version_created':     { version: 1, schema: SpecVersionCreatedV1 },
  'run.started':              { version: 1, schema: RunStartedV1 },
  'run.finished':             { version: 1, schema: RunFinishedV1 },
  'stage_report.posted':      { version: 1, schema: StageReportPostedV1 },
  'question.asked':           { version: 1, schema: QuestionAskedV1 },
  'question.answered':        { version: 1, schema: QuestionAnsweredV1 },
  'gate.evaluated':           { version: 1, schema: GateEvaluatedV1 },
  'approval.decided':         { version: 1, schema: ApprovalDecidedV1 },
  'budget.threshold_crossed': { version: 1, schema: BudgetThresholdV1 },
  'budget.blocked':           { version: 1, schema: BudgetBlockedV1 },
  'loop.detected':            { version: 1, schema: LoopDetectedV1 },
  'loop.escalated':           { version: 1, schema: LoopEscalatedV1 },
} as const;
```

Envelope, identical for every event:

```json
{
  "id": "evt_01J…",
  "type": "work_item.stage_changed",
  "version": 1,
  "occurred_at": "2026-07-25T18:29:00.000Z",
  "project": { "id": "…", "key": "ACME" },
  "subject": { "type": "work_item", "id": "…", "key": "ACME-14" },
  "actor": { "kind": "agent", "run_id": "…" },
  "data": { "from": { "key": "review" }, "to": { "key": "implementation" },
            "direction": "backward", "reason_code": "review_findings" }
}
```

Compatibility rules, published alongside the catalogue: adding an optional field to `data` is not a breaking change; removing or retyping a field is, and produces `type@2` delivered in parallel with `@1` for at least one phase. Consumers must ignore unknown fields — stated in the documentation, and demonstrated in the example consumer.

### 3.2 Delivery

```
events row (published_at null, type in PUBLIC_EVENTS)
  └─ dispatch job → for each enabled endpoint subscribed to the type and project
        └─ webhook_deliveries row (pending)
              └─ delivery job → POST with signature
                    ├─ 2xx → delivered
                    ├─ 4xx (not 408/429) → failed permanently, no retry, endpoint failure counter++
                    └─ 5xx/timeout/429 → retry with backoff (1m, 5m, 15m, 1h, 6h, 24h) → dead
```

- **Signing.** `X-Nexus-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">` with a per-endpoint secret, plus `X-Nexus-Event-Id`, `X-Nexus-Event-Type`, and `X-Nexus-Delivery-Id`. The documentation includes a verification snippet and states a five-minute tolerance window for replay protection.
- **Ordering** is per endpoint and best-effort by `occurred_at`; retries can reorder. The documentation says so and tells consumers to use `occurred_at` and `id`, not arrival order. Promising strict ordering would be a lie we would have to maintain.
- **At-least-once** delivery. `X-Nexus-Event-Id` is stable across retries so consumers can deduplicate; the documentation says to.
- **Auto-disable.** An endpoint with 100 consecutive failures or 24 hours of total failure is disabled, and its owner sees it in the inspector and (if configured) in Slack. Dead endpoints are the main source of queue backlog in systems like this.
- **Payload caps.** Bodies over 256 KB are truncated with `"truncated": true` and a link to fetch the full object through the API. Only stage reports and specs can approach this.

### 3.3 The REST API

OpenAPI-first, generated from the same zod schemas the internals use (`zod-to-openapi`), so drift between the spec and reality is structurally impossible.

```
GET    /api/v1/projects
GET    /api/v1/projects/{projectKey}
GET    /api/v1/projects/{projectKey}/work-items         ?stage=&complexity=&label=&status=&cursor=
POST   /api/v1/projects/{projectKey}/work-items
GET    /api/v1/work-items/{key}
PATCH  /api/v1/work-items/{key}                          title, description, complexity, labels
POST   /api/v1/work-items/{key}/transition               { to_stage, reason_code?, note? }
GET    /api/v1/work-items/{key}/spec                     ?version=
PUT    /api/v1/work-items/{key}/spec
GET    /api/v1/work-items/{key}/runs
GET    /api/v1/work-items/{key}/reports
GET    /api/v1/work-items/{key}/questions
POST   /api/v1/work-items/{key}/questions/{id}/answer
GET    /api/v1/work-items/{key}/events
POST   /api/v1/work-items/{key}/runs                     start a run (scope: runs:write)
GET    /api/v1/projects/{projectKey}/gates                read-only
GET    /api/v1/projects/{projectKey}/attention
POST   /api/v1/webhooks  GET/DELETE /api/v1/webhooks/{id}
GET    /api/v1/webhooks/{id}/deliveries                  ?status=
POST   /api/v1/webhooks/{id}/deliveries/{deliveryId}/replay
```

**PoC HTTP surface (implemented vs deferred).** Shipped on the openness branch: project/work-item/stage listing, create/update/transition, `POST …/runs`, paginated work-item lists, and `GET /api/v1/openapi.json`. Deferred past this PoC (UI or jobs only today): webhook CRUD over HTTP, gate/attention/spec HTTP writes, aggregate `/reports`, and inbound partner webhooks. Document any new route here before adding it.

Conventions: bearer token auth (Phase 2's token infrastructure with scopes); `Idempotency-Key` honoured on every POST/PUT (D17); keyset pagination (`?cursor=`, `next_cursor` omitted when exhausted — matching the convention Cursor's own API uses, since our users read both); RFC 9457 problem-detail error bodies; `X-Request-Id` echoed on every response; explicit `429` with `Retry-After`.

**Read broad, write narrow.** Everything readable is exposed. Writes cover exactly what an external tool needs to drive work: create and update items, transition, write specs, answer questions, start runs. Gate and budget *configuration* is read-only over the API because policy is a human, audited act in the PoC and API-driven policy edits would need a governance story we do not have yet.

Every API write goes through the same core service as the UI, so gates, budgets, and audit apply identically. An external caller cannot bypass a gate, and that is worth stating in the documentation.

### 3.4 Scopes

| Scope | Grants |
|---|---|
| `projects:read` | Projects, stages, labels, gates (read) |
| `items:read` | Work items, specs, runs, reports, questions, events |
| `items:write` | Create and update items, labels, complexity, specs |
| `items:transition` | Move items between stages |
| `runs:write` | Start and cancel runs (spends money — separate on purpose) |
| `questions:write` | Answer questions |
| `webhooks:manage` | Manage endpoints and replay deliveries |

Tokens are project-scoped and carry a subset of these. `runs:write` is deliberately separate: it is the only scope that can cause spend, and it should be grantable alone or withheld alone.

---

## 4. Data model changes

```sql
-- 0015_openness.sql
create table api_tokens (
  id uuid primary key,
  project_id uuid not null references projects(id),
  name text not null,
  token_hash text not null unique, token_prefix text not null,
  scopes text[] not null,
  created_by_user_id uuid references users(id),
  last_used_at timestamptz, use_count bigint not null default 0,
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table webhook_endpoints (
  id uuid primary key,
  project_id uuid not null references projects(id),
  url text not null,
  secret_hash text not null,               -- shown once at creation
  event_types text[] not null,             -- explicit subscription, no wildcards
  enabled boolean not null default true,
  description text,
  consecutive_failures integer not null default 0,
  disabled_at timestamptz, disabled_reason text,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table webhook_deliveries (
  id uuid primary key,
  endpoint_id uuid not null references webhook_endpoints(id),
  event_id uuid not null references events(id),
  event_type text not null,
  status text not null check (status in ('pending','delivered','failed','dead')),
  attempts integer not null default 0, next_attempt_at timestamptz,
  request_body_bytes integer, request_truncated boolean not null default false,
  response_status integer, response_body_excerpt text, response_ms integer,
  error text,
  delivered_at timestamptz, created_at timestamptz not null default now()
);
create index deliveries_pending on webhook_deliveries (status, next_attempt_at) where status = 'pending';
create index deliveries_endpoint on webhook_deliveries (endpoint_id, created_at desc);

create table api_request_log (
  id uuid primary key,
  token_id uuid references api_tokens(id),
  method text not null, path text not null, status integer not null,
  duration_ms integer, request_id text,
  idempotency_key text, idempotency_hit boolean not null default false,
  created_at timestamptz not null default now()
);

create table idempotency_keys (
  key text not null, token_id uuid not null references api_tokens(id),
  request_hash text not null, response_status integer, response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (key, token_id)
);

alter table events add column public_type text;   -- set when the type is in the catalogue
create index events_publishable on events (published_at, occurred_at) where public_type is not null;
```

---

## 5. Interfaces

```ts
// packages/core/src/webhooks
createEndpoint(ctx, { url, eventTypes, description }): Result<{ endpoint; secret }>  // secret shown once
dispatchEvents(ctx): Promise<DispatchSummary>        // job: events → deliveries
deliverPending(ctx): Promise<DeliverySummary>        // job: deliveries → HTTP
replayDelivery(ctx, deliveryId): Result<Delivery>
testEndpoint(ctx, endpointId): Result<Delivery>      // sends a synthetic ping event

// packages/core/src/api-tokens
createToken(ctx, { name, scopes, expiresAt }): Result<{ token; plaintext }>
revokeToken(ctx, id): Result<void>
```

**UI additions** in project settings:

- **API tokens:** create with scope checkboxes, plaintext shown once, last-used and usage count, revoke.
- **Webhooks:** register with an event-type picker, secret shown once, a "send test event" button, and status including auto-disable state.
- **Delivery inspector:** filterable delivery list (status, event type, time), each row expandable to request headers, body, response status, response excerpt, timing, and attempt history, with per-delivery and bulk replay.

---

## 6. Implementation steps

### Step 8.1 — Freeze the public event catalogue

**Changes.** `PUBLIC_EVENTS` with a zod schema per type; `public_type` populated on emit; a backfill for historical rows; `docs/events.md` with every type, its payload, an example, and the compatibility rules; a golden-file test that fails when a public payload schema changes without a version bump.

**Done when.** Every listed type is emitted by the phase that owns it, examples are generated from real fixtures rather than written by hand, and the compatibility test is in CI.

---

### Step 8.2 — Endpoints, signing, and delivery

**Changes.** Endpoint registration with secret generation; the dispatch job (events → deliveries, marking `published_at`); the delivery job with signing, timeouts (10 s), the backoff ladder, and status classification; the consecutive-failure counter and auto-disable; payload truncation; SSRF protection on registration (reject private address ranges, resolve and re-check at delivery, block redirects to private ranges).

**Done when.** A real external endpoint receives a signed event and verifies the signature using only the published snippet, and a private-network URL is rejected at registration.

---

### Step 8.3 — Inspector and replay

**Changes.** The delivery inspector UI; single and bulk replay (replay creates a new delivery attempt on the original event, never a new event); re-enable for auto-disabled endpoints with a required test-event success first; a delivery retention policy (30 days, bodies trimmed after 7).

**Done when.** The proof's failing-endpoint scenario works end to end: failures visible with reasons, endpoint fixed, replayed, delivered.

---

### Step 8.4 — REST API v1

**Changes.** Route handlers under `app/api/v1/` as thin adapters over core services; token authentication with scope enforcement in one middleware; keyset pagination helpers; problem-detail error mapping including the gate-blocked and budget-blocked cases (a `409` with the blocking reasons in the body, so an external caller learns the same thing a human would); idempotency middleware; OpenAPI generation from the zod schemas served at `/api/v1/openapi.json`.

**Done when.** The generated OpenAPI document validates, an external script drives an item from creation to Deploy, and attempting a gate-blocked transition through the API returns a legible `409`.

---

### Step 8.5 — Tokens, scopes, and rate limits

**Changes.** Token CRUD and UI; scope checks with clear `403` bodies naming the missing scope; per-token rate limiting in Redis (default 600 requests/minute, burst 60/second) with `429` and `Retry-After`; usage logging; a Redis-unavailable fallback to a conservative in-process limit rather than to no limit.

**Done when.** Scope enforcement is proven per endpoint by test, a token over its limit gets `429` with `Retry-After`, and Redis being down does not remove rate limiting.

---

### Step 8.6 — Documentation and examples

**Changes.** `docs/api.md` (authentication, scopes, pagination, errors, idempotency, rate limits) and `docs/webhooks.md` (catalogue, envelope, signature verification, retries, ordering caveats, deduplication); a runnable `examples/` directory with a TypeScript script that creates a ticket and follows it to Deploy, and a small webhook consumer that verifies signatures; a Postman/Bruno collection generated from the OpenAPI document.

**Done when.** Someone outside the team completes both examples from the documentation alone, without reading our source.

---

### Step 8.7 — Hardening and flag removal

**Changes.** A load test of 10,000 queued deliveries draining within the backoff ladder's expectations; a queue-depth alert on `/api/health`; audit coverage for every API write (actor kind `api_token` throughout); a security review pass over the new surface (SSRF, timing-safe token comparison, no secret in any log or error body); flag removal.

**Done when.** The load test drains cleanly, and the security review finds nothing outstanding.

---

## 7. Testing and verification

- **Unit.** Signature generation and verification including tolerance-window rejection; backoff schedule; status classification (which HTTP codes retry); pagination cursors; scope resolution; idempotency key matching including the mismatched-body case (same key, different payload must fail loudly).
- **Integration.** A local HTTP server as the consumer: successful delivery, 500-then-recover, permanent 400, timeout, redirect-to-private-address; replay creating a new attempt rather than a new event; auto-disable and re-enable; every API endpoint against real data with real gates active.
- **Contract.** The OpenAPI document validated in CI, and a generated client exercised against the running app so the documentation is proven executable.
- **Security.** SSRF attempts; token brute-force protection; a revoked token immediately refused; verification that no response body or log line contains a secret.
- **End-to-end.** The proof's two scenarios automated against the preview deployment.

## 8. Rollout and safety

- Flags `p8.webhooks` and `p8.api`, per project — a project can have events without an API or the reverse.
- The API is additive and read-broad/write-narrow; nothing existing changes behaviour when it is enabled.
- Every API write goes through the same services as the UI, so Phase 3 gates and Phase 4 budgets apply identically — an external caller has no privileged path.
- Webhook delivery is isolated in the job queue: a slow consumer cannot affect request latency, and a flooded queue is visible on the health endpoint.
- Secrets (endpoint secrets, token plaintexts) are shown exactly once and stored hashed.

## 9. Demo script (the proof)

1. **Register.** In project Alpha, register a webhook endpoint (an ngrok-style receiver visible on screen) subscribed to the full catalogue. Show the secret once, then show that it is unrecoverable.
2. **A full lifecycle, watched from outside.** Drive a ticket from creation to Deploy — created, stage changes, run started and finished, report posted, question asked and answered, gate evaluated, budget threshold crossed, loop detected. Each event arrives at the receiver within seconds, in order, with a valid signature. Show the verification snippet running.
3. **Failure and recovery.** Point the endpoint at a URL that returns 500. Trigger events; show deliveries failing with reasons and attempt counts in the inspector, and the backoff schedule. Fix the endpoint, replay the failed deliveries, watch them land.
4. **Auto-disable.** Show an endpoint disabled after sustained failure, and the required successful test event before re-enabling.
5. **Drive from outside.** Run the example script: create a ticket, set complexity, write a spec, transition through stages, read state at each step — all through the API with a scoped token, all visible in the UI as it happens.
6. **The API cannot cheat.** Attempt a transition the API token's project has gated: `409` with the blocking gate named. Attempt a run with a token lacking `runs:write`: `403` naming the missing scope. Both actions are in the audit trail as `api_token` actor.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| Public payloads harden too early | Frequent requests to change a `data` field | Allow-list rather than firehose; additive-only compatibility rules; versioned types with parallel delivery |
| Webhook delivery becomes a queue problem | Growing `deliveries_pending` on the health endpoint | Auto-disable dead endpoints, cap retries, alert on depth, isolate in the job queue |
| SSRF through registered URLs | A registration attempt at a private address | Reject at registration and re-check at delivery; block redirects to private ranges; document the policy |
| API bypasses process | An external tool advances items past gates | All writes go through core services; a paired test asserts API and UI reach the same blocked outcome |
| Token sprawl | Many long-lived tokens with broad scopes | Expiry encouraged in the UI, last-used shown prominently, unused tokens flagged after 30 days |
| Documentation drifts from behaviour | Support questions that the docs answer incorrectly | OpenAPI generated from the same schemas; examples run in CI against the app |
| Idempotency misuse | Duplicate items created by a retrying client | Same key with a different body returns `422` rather than silently doing the wrong thing |

## 11. Exit criteria

- [ ] The public event catalogue is documented, frozen, and covered by compatibility tests.
- [ ] A full ticket lifecycle delivers every catalogued event to an external endpoint with valid signatures.
- [ ] Failed deliveries are visible with reasons and can be replayed after a fix.
- [ ] Endpoints auto-disable on sustained failure and require a successful test before re-enabling.
- [ ] An external script creates a ticket, sets complexity, and reads state through to Deploy.
- [ ] Scopes are enforced per endpoint; `runs:write` is separable.
- [ ] Rate limiting and idempotency work, including the mismatched-body case.
- [ ] OpenAPI is generated from the implementation and validated in CI.
- [ ] API writes are subject to the same gates and budgets as the UI, proven by paired tests.
- [ ] SSRF protections and secret handling pass a security review.

## Deviations recorded during implementation

- **Webhook signing secret storage:** Plan SQL shows `secret_hash` only; reversible signing requires the plaintext at delivery time. Implemented `secret_encrypted` (AES-256-GCM using `MCP_TOKEN_SIGNING_KEY` / `WEBHOOK_SECRET_ENCRYPTION_KEY`) alongside `secret_hash` (SHA-256 of `whsec_*`).
- **Shared `published_at`:** Replaced with per-consumer cursors in `app_meta` (`attention_dispatcher_cursor`, `webhook_dispatcher_cursor`). Attention no longer writes `published_at`.
- **Migration number:** Openness schema is `0018_openness.sql` (stack renumbering reserves 0016–0017).
- **OpenAPI:** Served at `/api/v1/openapi.json` via `@asteasolutions/zod-to-openapi` from zod schemas in `apps/web/src/server/openapi-v1.ts` (paths grow with the API surface).
- **Webhook backlog latency:** A single `dispatchWebhookEvents` call advances the cursor by at most `limit` rows in global `occurred_at` order **within one org**. With a deep backlog, delivery latency scales with backlog depth in per-batch cron ticks (measured: 2,500 filler events + `limit=100` → 25 ticks). The `dispatch_webhook_events` job uses `dispatchWebhookEventsDrain` (up to 50×200 events per org per tick).
- **Per-org webhook cursor (tenancy fix):** Replaced global `webhook_dispatcher_cursor` with `webhook_dispatcher_cursor:<orgId>` and `eq(events.orgId, ctx.orgId)` on the poll. `migrateLegacyWebhookDispatcherCursor` copies the legacy global row to every org on job tick so preview deploys do not replay history. New orgs without a legacy row start at null (org-scoped only). Regression: `tenancy.integration.test.ts` (fails on global cursor — org A sees 100 cross-tenant rows in one pass).
- **Mutation table (`classifyHttpStatus(500)`):** Applying `if (status === 500) return 'permanent_failure'` makes `packages/core/src/webhooks/mutation.test.ts` fail (`expected 'permanent_failure' to be 'retry'`) — probe is Red, not mental-only.
- **`work_item.status_changed`:** Emitted from `transitionWorkItem` and `updateWorkItem` when derived status changes (`packages/core/src/workitems/status-changed.ts`).
- **Removed delivery integration test (interim):** `packages/core/src/webhooks/delivery.integration.test.ts` was added locally during the first push, deleted before commit when flaky, then **restored** with loopback listener + `advanceOutboxCursorToLatest` so only the new event is dispatched. Manual verification: signing unit tests + outbox cursor test + HTTP delivery integration test.

## 12. Open questions for this phase

- **Local:** should the API expose gate *configuration* writes? Recommendation: no for the PoC. Policy edits are human, audited acts, and API-driven policy needs a governance model we have not designed.
- **Local:** do we need per-endpoint event filtering beyond type — for example, only items with a given label? Recommendation: no. Consumers filter; we keep delivery simple.
- **Local:** how long do we retain deliveries and request logs? Recommendation: deliveries 30 days with bodies trimmed at 7; request logs 30 days then aggregated.
- **Local:** should events carry a full object snapshot or just the delta? Recommendation: delta plus stable identifiers, with the documentation pointing at the API for the full object. Snapshots would freeze our internal shape into a public contract.
