# Architecture baseline

Shared technical context for every phase plan. This document describes the platform we are building on, the shape of the codebase, and the conventions each phase assumes. Phase plans reference it rather than repeating it.

---

## 1. The platform we inherit

This repository is an **internalsphere** app repo. The `internal-app-orchestrator` ("ranger") control plane owns everything except application code, and its constraints are not negotiable from inside this repo. They shape the architecture more than any product requirement does.

| Constraint | Evidence in this repo | Architectural consequence |
|---|---|---|
| Vercel project is `nexus` in the `anysphere-internal` team | `.github/workflows/managed-app.yml` (`project_name: nexus`, environments `nexus-preview` / `nexus-production`) | One deployable unit. Everything — UI, REST API, MCP server, cron workers — runs in one Next.js app. |
| Deploys only happen through the managed workflow | `managed-app.yml`; `QUICKSTART.md` "Deploying your changes" | No local Vercel runtime. Every integration-touching change is validated on the PR preview deploy. |
| `vercel env pull`, `vercel dev`, `vercel deploy` are unavailable (everyone has Viewer) | `.cursor/skills/internalsphere-setup/SKILL.md` | Local development runs against local Postgres/Redis in Docker with a `.env.local` the developer writes by hand. Local mode must degrade gracefully with integrations absent. |
| Secrets are SOPS-encrypted files synced to Vercel | `secrets/`, `.sops.yaml`, `scripts/secrets.py` | Every new credential is added via `python3 scripts/secrets.py add --scope <shared\|preview\|production> --key <KEY>` in its own PR. Never in `.env`, code, or tests. |
| Managed resources are declared, not provisioned | `app-manifest.yml`, `scripts/app-manifest.py` | Postgres, Redis and Blob are requested by adding `integrations.<alias>.type`; the orchestrator creates them and injects `<ALIAS>_*` env vars. Preview and production get separate instances. |
| Migrations run in CI before each deploy | `.cursor/skills/supabase-database/SKILL.md` | A root `db:exec-migrations` script is the only migration entry point. It runs against the target environment's database *before* the new code serves traffic. |
| Deployments are Passport-protected by default | `internalsphere-setup` skill, "Reading signed-in user identity from Passport" | Humans authenticate via Okta Passport with zero app-side login code. Machines (Cursor agents, external API clients) cannot pass Passport and need a **Protection Bypass for Automation** header — a hard external dependency, see §6.2. |
| `main` is protected; the only path is PR → preview → merge | `QUICKSTART.md` "Required checks" | Trunk-based development with feature flags. Long-lived branches are not viable. |
| Policy-managed files must not be edited | `QUICKSTART.md` "Important guardrails" | Do not touch `managed-app.yml`, `CODEOWNERS`, `.sops.yaml`, `scripts/*`, `secrets/inventory.yaml`, distributed skills, or `QUICKSTART.md`. Anything we need from CI beyond what `ci-required` provides must be requested in `#proj-internalsphere` (see `open-questions.md` Q6). |

### 1.1 Integrations we will declare

`app-manifest.yml` grows to this over Phases 0–2 (each addition is its own PR, and each one waits for orchestrator reconciliation before code can use it):

```yaml
version: 1
owner: tobias.urban@anysphere.co
vercel:
  root_directory: apps/web
integrations:
  db:
    type: supabase        # Phase 0 — Postgres. Sole system of record.
  cache:
    type: upstash-kv      # Phase 2 — distributed locks, rate limits, idempotency, short-lived caches.
```

- **Supabase is used as Postgres only.** No Supabase Auth (Passport owns identity), no PostgREST from the browser, no Realtime in the PoC. Env vars arrive as `DB_POSTGRES_URL`, `DB_POSTGRES_URL_NON_POOLING`, `DB_SUPABASE_URL`, `DB_SUPABASE_SERVICE_ROLE_KEY`, …
- **Vercel Blob is deliberately not declared.** The vision stores *references* to artifacts, not artifact bytes (`VISION.md` §4.5). Revisit only if Phase 9 exports need somewhere to live.

---

## 2. Repository layout

A pnpm + Turborepo monorepo with one deployable app. The package split exists to keep domain logic testable without Next.js and to make the three delivery surfaces (UI, REST, MCP) thin adapters over one service layer.

```
.
├── apps/
│   └── web/                        # the only deployable: Next.js App Router
│       ├── app/
│       │   ├── (app)/              # authenticated human UI (RSC)
│       │   │   ├── inbox/          # P6
│       │   │   ├── projects/[projectKey]/
│       │   │   │   ├── board/      # P1 → P6
│       │   │   │   ├── items/[key]/# P1 → P7
│       │   │   │   ├── settings/   # P1 → P7
│       │   │   │   └── policies/   # P3 (Policy Studio, if chosen)
│       │   │   └── admin/          # P9
│       │   ├── api/
│       │   │   ├── mcp/route.ts    # P2 — MCP streamable HTTP endpoint
│       │   │   ├── v1/             # P8 — public REST API
│       │   │   ├── cron/           # P2 — scheduler entry points
│       │   │   └── health/route.ts # P0
│       │   └── layout.tsx
│       ├── vercel.json             # framework preset + cron definitions
│       └── next.config.ts
├── packages/
│   ├── contracts/                  # zod schemas + inferred types: MCP tools, REST DTOs,
│   │                               # stage report, events, condition DSL. No runtime deps.
│   ├── db/                         # Drizzle schema, migrations, connection factory, repositories
│   ├── core/                       # domain services — the only place business rules live
│   │   ├── projects/  workitems/  specs/  pipeline/     # P1
│   │   ├── runs/      reports/    questions/            # P2
│   │   ├── gates/     conditions/ status/               # P3
│   │   ├── cost/      budgets/                          # P4
│   │   ├── loops/                                       # P5
│   │   ├── attention/                                   # P6
│   │   ├── rubrics/                                     # P7
│   │   ├── events/    webhooks/                         # P1 outbox, P8 delivery
│   │   ├── estimates/ analytics/                        # P9
│   │   └── authz/                                       # P1, hardened P9
│   ├── cursor-client/              # typed client for Cursor Cloud Agents v1 + Admin API
│   ├── mcp/                        # MCP tool definitions bound to core services
│   ├── jobs/                       # durable queue, worker registry, scheduler
│   ├── ui/                         # shared React components (shadcn/ui based)
│   └── config/                     # eslint, tsconfig, tailwind, vitest presets
├── docs/
│   ├── decisions/                  # ADRs written during Phase 0 and after
│   ├── mcp-contract.md             # the frozen agent-facing contract (P2)
│   └── runbook.md                  # on-call/demo runbook (P9)
└── Implementation plan/            # this planning material
```

**Dependency rule (enforced by an ESLint boundaries rule in Phase 1):**

```
apps/web  →  mcp, jobs, core, db, contracts, ui, cursor-client
core      →  db, contracts, cursor-client
db        →  contracts
contracts →  (nothing)
```

`packages/core` must never import from `next/*`, `react`, or `apps/web`. If a service needs the current user, it takes an `Actor` argument. This is what makes the same service callable from a React Server Component, a REST handler, an MCP tool, and a background job.

### 2.1 Toolchain

pnpm workspaces, Turborepo, TypeScript strict, Next.js App Router with React Server Components, Tailwind + shadcn/ui, Drizzle ORM + drizzle-kit, zod, Vitest, Playwright, pino. **Exact versions are pinned in Phase 0 step 0.1** against whatever is current at kickoff and recorded in `docs/decisions/ADR-0001-stack.md`; the plans deliberately avoid version numbers that will be stale.

---

## 3. Runtime topology

```
Browser (Okta Passport)                Cursor cloud agent                 External tooling (P8)
        │                                      │                                   │
        │ RSC / server actions                 │ MCP over HTTP                     │ REST /api/v1
        ▼                                      ▼                                   ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ Next.js app on Vercel (project `nexus`)                                               │
│   route handlers · server actions · RSC     ← thin adapters                           │
│   ────────────────────────────────────────────────────────────────────────────────    │
│   packages/core services                    ← all business rules, all authorisation   │
│   ────────────────────────────────────────────────────────────────────────────────    │
│   packages/db (Drizzle)   packages/jobs   packages/cursor-client                      │
└───────┬────────────────────────┬────────────────────────────┬─────────────────────────┘
        │                        │                            │
        ▼                        ▼                            ▼
  Supabase Postgres        Upstash Redis                api.cursor.com
  (state + outbox +        (locks, rate limits,         (create agent, poll run,
   job queue)               idempotency)                 usage, cancel)
        ▲
        │ every minute
  Vercel Cron ──► /api/cron/tick ──► claims jobs from the queue
```

**Everything durable lives in Postgres.** Redis is a performance and coordination aid only; losing it must degrade the system, never corrupt it.

### 3.1 Background work

Vercel functions are request-scoped, so "background processing" is a cron-driven worker over a Postgres job queue:

```ts
// packages/jobs/src/queue.ts
export async function claimJobs(db: Db, workerId: string, limit = 20) {
  return db.execute(sql`
    UPDATE jobs SET status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
      ORDER BY priority DESC, run_after ASC
      FOR UPDATE SKIP LOCKED LIMIT ${limit}
    )
    RETURNING *;
  `);
}
```

- `/api/cron/tick` runs every minute (declared in `apps/web/vercel.json`), claims a batch, and executes handlers until near the function time limit, then returns. Long queues drain over successive ticks.
- Handlers are registered by name in `packages/jobs/src/registry.ts` and must be **idempotent** — a job can run twice.
- Failures use exponential backoff with jitter and a `max_attempts` cap; exhausted jobs move to `status = 'dead'` and raise an internal event.
- Latency-sensitive work (launching a run right after a human clicks) is enqueued *and* attempted inline via `waitUntil()` from `@vercel/functions`; the queue is the safety net, not the primary path.
- Cron requests are authenticated with `CRON_SECRET`; the handler rejects anything without it.

---

## 4. Data conventions

- **Postgres 15+ via Supabase.** Runtime connections use the pooled URL (`DB_POSTGRES_URL`, Supavisor transaction mode) with `postgres.js` configured `prepare: false`; migrations use the direct URL (`DB_POSTGRES_URL_NON_POOLING`).
- **Identifiers:** `uuid` primary keys generated application-side as UUIDv7 (time-ordered, index-friendly, safe to generate before insert so the outbox can reference them in the same transaction). Human-facing work items also carry `key` (`ACME-14`) allocated by `UPDATE projects SET next_item_number = next_item_number + 1 RETURNING`.
- **Time:** `timestamptz`, always UTC, always `now()` from the database for state changes.
- **Money:** `bigint` micro-dollars (`*_micro_usd`, 1 USD = 1_000_000). Cursor reports fractional cents (`chargedCents: 21.36232`); converting to integer micro-dollars at ingest avoids float drift in rollups.
- **Flexible payloads:** `jsonb`, always parsed through a zod schema from `packages/contracts` at the boundary. A `jsonb` column without a schema is a bug.
- **Every table** has `created_at timestamptz not null default now()` and, where mutable, `updated_at`. Deletion is `archived_at` except for genuinely disposable rows (jobs, deliveries).
- **Enumerations** are Postgres `text` columns with a `CHECK` constraint plus a zod enum, not native enum types (adding a value to a native enum is awkward under expand/contract).
- **Concurrency:** work items carry an integer `version` for optimistic locking on transitions; run launches take a Postgres advisory lock keyed on the work item id so two clicks cannot start two runs.
- **RLS as defence in depth:** every table has `ENABLE ROW LEVEL SECURITY` with no permissive policies, and `anon`/`authenticated` roles are revoked from the application schema. Nothing but our server-side connection can read the data even if a Supabase key leaks.

### 4.1 Migrations

- Authored with `drizzle-kit generate`, reviewed as SQL, committed under `packages/db/migrations/`.
- Root `package.json` exposes `"db:exec-migrations": "pnpm --filter @nexus/db exec-migrations"` — CI calls this before every preview and production deploy.
- Forward-only. Renames and drops use expand/contract across two deploys: add new → backfill → switch code → drop old in a later PR.
- Every migration PR states in its description what happens if the deploy that follows it fails and the old code keeps running.

### 4.2 The event outbox (built in Phase 1, exposed in Phase 8)

Every state change writes an `events` row **in the same transaction** as the change. This single mechanism serves the audit log, the activity feed, attention item maintenance (P6), and outbound webhooks (P8). Building it in Phase 1 costs little; retrofitting it in Phase 8 would mean touching every service.

```ts
await db.transaction(async (tx) => {
  const item = await workItems.update(tx, id, patch);
  await events.emit(tx, {
    type: 'work_item.stage_changed',
    projectId: item.projectId,
    subject: { type: 'work_item', id: item.id },
    actor,
    payload: { from, to, reason },
  });
});
```

Event `type` strings are namespaced (`work_item.*`, `run.*`, `gate.*`, `question.*`, `budget.*`) and their payloads are zod schemas in `packages/contracts/src/events`. Payload changes are additive only once Phase 8 ships.

---

## 5. Service layer conventions

```ts
// packages/core/src/workitems/transition.ts
export async function transitionWorkItem(
  ctx: ServiceContext,            // { db, actor, clock, logger, flags }
  input: TransitionInput,         // zod-parsed at the adapter boundary
): Promise<Result<WorkItem, TransitionError>>
```

- Services return a `Result` union rather than throwing for expected failures (`gate_blocked`, `budget_exceeded`, `stale_version`). Exceptions are reserved for programmer error and infrastructure faults.
- `ServiceContext.actor` is a discriminated union: `{ kind: 'human', userId }`, `{ kind: 'agent', runId, workItemId }`, `{ kind: 'system', reason }`, `{ kind: 'api_token', tokenId }`. Authorisation and audit both key off it, so agent-driven and human-driven changes are always distinguishable in history.
- Authorisation is a single module (`packages/core/src/authz`) exposing `can(actor, action, resource)`. Adapters never make their own access decisions.
- Services are pure with respect to transport: no `Request`, no `Response`, no cookies.

---

## 6. Identity, authentication, authorisation

### 6.1 Humans

Vercel Passport terminates Okta SSO before our code runs and forwards a Vercel-signed JWT in `x-vercel-oidc-passport-token`. Per the internalsphere skill: read it **server-side only**, use `external_sub` as the stable user id, and treat `email`/`name` as optional.

```ts
// apps/web/src/server/identity.ts
export async function currentUser(): Promise<AppUser | null> {
  const token = (await headers()).get('x-vercel-oidc-passport-token');
  if (!token) return devFallbackUser();          // local dev only; asserts !process.env.VERCEL
  const claims = await verifyPassportToken(token);
  return users.upsertFromPassport(claims);        // external_sub → users row
}
```

A missing header is expected locally and never falls back to a user-supplied identity header in a deployed environment.

### 6.2 Machines (the load-bearing bit)

Cursor cloud agents and external API clients cannot complete Passport. Two headers get them in:

1. `x-vercel-protection-bypass: <PROTECTION_BYPASS_SECRET>` — gets the request past Vercel's deployment protection. This must be requested in `#proj-internalsphere` ("Protection Bypass for Automation"), exactly as the internalsphere skill describes for webhook integrations. **Phase 0 cannot complete without it.**
2. `Authorization: Bearer <nexus token>` — our own authentication, checked in the route handler. Bypass only removes the edge gate; it grants nothing inside the app.

Two token families:

| Token | Minted | Scope | Lifetime |
|---|---|---|---|
| **Run token** (P2) | By the run launcher, one per run, injected into the agent through the Cloud Agents API `mcpServers[].headers` | Exactly one work item, the tools its stage needs | Run duration + grace, revoked on terminal status |
| **API token** (P8) | By a project admin in settings | Project-scoped, with explicit scopes | Until revoked |

Both are stored as SHA-256 hashes with a non-secret lookup prefix; the plaintext is shown once. Every authenticated machine request is logged with token id, tool/endpoint, and work item.

### 6.3 Roles

`project_members.role ∈ {owner, maintainer, member, viewer}`. The permission matrix lands in Phase 1 and is completed in Phase 9 (`VISION.md` §17.7). The rules that matter early: only `owner`/`maintainer` may edit gates, bindings, and budgets or raise a cap; `member` may create work items, answer questions, and approve gates the project marks member-approvable; `viewer` is read-only.

---

## 7. Verified integration facts

Confirmed against Cursor's public documentation while writing these plans. Re-verify in Phase 0 step 0.4 — the Cloud Agents v1 API is in public beta and *will* change.

**Cloud Agents API v1** (`https://api.cursor.com`, Basic or Bearer auth with a user or service-account API key):

| Capability | Endpoint | Why it matters here |
|---|---|---|
| Create agent + first run | `POST /v1/agents` | Accepts `prompt.text`, `model`, `repos[]`, `autoCreatePR`, **`mcpServers[]` with per-server `headers`**, and a client-supplied `agentId` (`bc-<uuid>`) that returns `409 agent_id_conflict` on replay |
| Follow-up run | `POST /v1/agents/{id}/runs` | Resumes the same conversation and workspace; `mcpServers` can be replaced per run. Only one active run per agent — otherwise `409 agent_busy` |
| Read run | `GET /v1/agents/{id}/runs/{runId}` | `status`, `durationMs`, `result`, `git.branches[]` |
| Live events | `GET /v1/agents/{id}/runs/{runId}/stream` | SSE with `Last-Event-ID` resume, heartbeats, and a retention window after which it returns `410 stream_expired` |
| Cancel | `POST /v1/agents/{id}/runs/{runId}/cancel` | Terminal; `409 run_not_cancellable` if already finished |
| Token usage | `GET /v1/agents/{id}/usage?runId=…` | Per-run `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, and a `usageUuid` |
| Artifacts | `GET /v1/agents/{id}/artifacts`, `…/artifacts/download` | 15-minute presigned URLs — store the path, mint the URL on demand |
| Metadata | `GET /v1/me`, `GET /v1/models`, `GET /v1/repositories` | `/v1/repositories` is rate-limited to 1/user/min — cache aggressively |

Two documented quirks the design must absorb:

- **`git` is per-agent, not per-run.** Every run on an agent returns the same branch snapshot. Branch/PR attribution to a specific run is best-effort; we record the snapshot at run terminal time and never treat it as authoritative for an individual run. This is the "per-agent git snapshot quirk" in `VISION.md` §F1.
- **v1 webhooks are "coming soon".** Only the legacy v0 API supports outbound webhooks. The plan therefore assumes **poll-first observation** and treats any webhook as an accelerator (D7).

**Automations** (`VISION.md`'s primary orchestration concept): created in the Cursor UI or via `/automate`; a webhook trigger exposes a private endpoint that requires `Authorization: Bearer <automation key>`, and the POSTed JSON payload is appended to the agent's instructions. Automations carry their own MCP configuration and run as the author's identity or, when Team Owned, as the team's automations service account.

**Admin API** (Enterprise, team-scoped key): `POST /teams/filtered-usage-events` returns per-event `chargedCents`, `tokenUsage`, `model`, `isHeadless`, `serviceAccountId`, and — decisively for us — **`cloudAgentId` and `automationId`, both of which can be filtered on**. Data is aggregated hourly; poll at most once per hour. This is the reconciliation path in Phase 4, and `cloudAgentId` is the join key back to our `runs` table.

---

## 8. Testing strategy

| Layer | Tool | What it covers | Where it runs |
|---|---|---|---|
| Unit | Vitest | Pure logic: condition evaluation, status derivation, ranking, cost maths, prompt building | Every PR |
| Integration | Vitest + Postgres in Docker | Services against a real schema: transitions, gate evaluation, budget enforcement, outbox writes, job handlers | Every PR |
| Contract | Vitest + an in-process MCP client | Every MCP tool's request/response against the frozen zod schemas, plus authorisation and idempotency behaviour | Every PR |
| External | Recorded fixtures + one nightly live smoke | `cursor-client` against captured API responses; a nightly job hits the real API to catch beta drift | PR + nightly |
| End-to-end | Playwright | Critical human journeys against the **PR preview URL**, authenticated with the bypass secret | Per PR (Phase 1 onward) |

Local integration tests use `docker compose up postgres redis`; no test may require Vercel or Supabase credentials. Test data is built by typed factories (`packages/core/test/factories.ts`), never by raw SQL fixtures.

---

## 9. Feature flags and rollout

Because merging to `main` deploys production, every phase ships dark:

- `feature_flags` table (`key`, `enabled`, `enabled_for_project_ids[]`, `updated_by`) with an env-var override for emergencies, read through `ctx.flags`.
- Flag naming matches the phase: `p3.gates`, `p4.budgets`, `p6.inbox`, `p7.agentic_gates`.
- Flags are removed in the phase's final step. A flag surviving past its phase is technical debt with a name.
- Anything invoking a Cursor agent also respects a global `orchestration.enabled` kill switch — one place to stop all spend.

## 10. Observability

- `pino` structured JSON logs to Vercel runtime logs. Every log line carries `requestId`, and where applicable `actorKind`, `projectId`, `workItemId`, `runId`, `jobId`.
- Job handlers log start/finish/duration/outcome; the scheduler logs queue depth each tick so backlog is visible without a metrics stack.
- `/api/health` reports database connectivity, migration version, queue depth, and oldest pending job — the single URL to check when a demo misbehaves.
- The `events` table doubles as the audit trail; the admin UI (P9) reads it directly.
- Error tracking (Sentry) is optional and deferred; if adopted, the DSN goes through `scripts/secrets.py` like any other credential.

## 11. Security posture for the PoC

- No secrets in the repo. Ever. `secrets-guard.py` runs pre-commit; CI and Security Bugbot re-check.
- The Supabase service-role key and database URL never reach the browser; no `NEXT_PUBLIC_*` variable may hold a credential.
- MCP and REST inputs are size-capped and zod-validated; spec and report bodies have explicit byte limits so an agent cannot write unbounded content.
- Prompt-injection fencing is explicitly out of PoC scope (`VISION.md` §3), but agent-supplied content is stored and rendered as untrusted: markdown is sanitised, links are never auto-followed by the backend, and `labels_to_set` is validated against the project taxonomy rather than free-form.
- Run tokens are the narrowest credential we can issue: one work item, short-lived, revoked on run completion.
