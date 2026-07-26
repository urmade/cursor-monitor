# Phase 1 — System of record

> **Outcome.** "Projects, work items, complexity, labels, stages, and specs exist and persist. A human can use the system as a plain tracker with no agents involved: create a project with its own pipeline and label taxonomy, create tickets, set complexity, move tickets through stages, and see a complete history of what changed and who changed it."
>
> **Proof.** Two projects with different pipelines and different label taxonomies coexist. A ticket is created, specced by hand, moved through every stage to Deploy, and its full transition history is auditable. Nothing is hardcoded to a single project shape.
>
> **Depends on.** Phase 0 decisions on the shape of core objects. Nothing external. **Unblocks.** Every subsequent phase.

---

## 1. Objective and scope

Phase 1 builds the nouns. Every later phase attaches to them, so the cost of getting them wrong compounds: a missing `stage_instance` in Phase 1 means no loop cost in Phase 5; a mutable status column means a fight in Phase 3.

Three things make this more than CRUD:

1. **Per-project configurability from the first row.** Pipelines and label taxonomies are data, not enums. The proof requires two projects with genuinely different shapes.
2. **History is a first-class output**, not a side effect. The event outbox (D13) is written in this phase even though nothing reads it until Phase 6 and nothing publishes it until Phase 8.
3. **Derived status exists from day one** (D10), even though in Phase 1 it derives from almost nothing. Introducing it later means unpicking every place a status was written by hand.

### In scope

Organisations and users; projects with pipelines and label taxonomies; work items with complexity, labels, and versioned specs; stages, stage instances, and transitions; the event outbox and audit trail; project membership and the authorisation module; the board, ticket detail, and project settings surfaces at v1; the test harness and seed data.

### Out of scope

| Not in Phase 1 | Lands in |
|---|---|
| Anything that starts or observes an agent | Phase 2 |
| Guarding transitions — stage movement is manual and unvalidated beyond pipeline adjacency rules | Phase 3 |
| Budgets, cost, spend | Phase 4 |
| Loop semantics on backward transitions (they are recorded, not interpreted) | Phase 5 |
| The inbox (the board is the only surface) | Phase 6 |
| Public API and webhook delivery (events are stored, not published) | Phase 8 |

---

## 2. Preconditions

- Phase 0 complete and torn down: the monorepo deploys, migrations run in CI, Passport identity works, and `main` has no spike artefacts.
- The object-shape findings from Phase 0 (`docs/decisions/phase-0-report.md`) have been read; in particular, whatever the run/report spike learned about what agents actually need to read.
- Q6 (what `ci-required` runs) answered or being chased, so tests can gate merges.

---

## 3. Technical approach

### 3.1 Pipelines are data

A project owns an ordered list of stages. Nothing in the codebase may reference a stage by name — not `if (stage === 'review')`, not a `Stage` TypeScript union. Stages carry semantic flags instead:

```ts
type Stage = {
  id: string; projectId: string; key: string;      // 'intake', unique per project
  name: string; position: number;                   // ordering, gaps allowed
  defaultOwnerClass: 'ai' | 'human' | 'external';
  isInitial: boolean;                               // exactly one per project
  isTerminal: boolean;                              // Deploy, in the default pipeline
  archivedAt: Date | null;
};
```

Where later phases need to say "a review-like stage", they express it as a condition over stage keys or labels in project configuration — never in code. This is what the proof's "nothing is hardcoded to a single project shape" is testing.

Two seeded templates make project creation pleasant without making them special: **Default** (Intake → Scoping → Plan → Implementation → Review → Deploy, per `VISION.md` §4.4) and **Minimal** (Intake → Implementation → Deploy). A template is copied into project-owned rows at creation; changing a template never changes an existing project.

### 3.2 Blocking states are orthogonal to stages

`VISION.md` §4.4 is explicit that `Needs answer`, `Needs approval`, `Blocked (external)`, `Paused (budget)`, `Failed (run)` and `Abandoned` are **not** stages. They are computed by `deriveStatus`. In Phase 1 only three inputs exist (`archivedAt`, an explicit external-block flag, and a manual override), and the function returns `ai_working` or `idle` for everything else. Phases 2–5 each add inputs to the same function; the signature is designed for that now:

```ts
// packages/core/src/status/derive.ts
export function deriveStatus(item: WorkItem, facts: StatusFacts): DerivedStatus;

export type StatusFacts = {
  activeRuns: number;              // P2
  openBlockingQuestions: number;   // P2
  failedRunsSinceLastSuccess: number; // P2
  pendingApprovals: number;        // P3
  blockingGateResults: number;     // P3
  budgetState: 'ok' | 'warn' | 'blocked'; // P4
  loopEscalated: boolean;          // P5
  override: StatusOverride | null;
};
```

Every field except `override` is defaulted to zero in Phase 1. The function is pure and unit-tested with a truth table that grows each phase.

### 3.3 Stage instances from the beginning

Entering a stage creates a `stage_instances` row; leaving closes it. In Phase 1 they only record time. They exist now because Phase 2 attaches runs to them, Phase 4 attaches cost, and Phase 5 counts them to detect loops. Retro-fitting stage instances after runs exist would mean reconstructing history that was never recorded.

### 3.4 Specs are append-only versions

A spec version is immutable; editing creates a new version and moves the work item's `current_spec_version_id`. Content is `jsonb` validated against a project-resolved schema:

```ts
const SpecContent = z.object({
  summary: z.string().max(20_000).default(''),
  context: z.string().max(20_000).optional(),
  approach: z.string().max(20_000).optional(),
  acceptanceCriteria: z.array(z.string().max(1_000)).optional(), // only when the project enables it (P7)
  openQuestions: z.array(z.string().max(1_000)).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
```

The vision insists the system must not force acceptance criteria (`VISION.md` §9), so the field exists in the schema but is neither required nor surfaced unless the project's `optional_concepts` enables it. Phase 7 turns that flag on; Phase 1 only ensures nothing breaks when it is off.

### 3.5 Everything writes an event

```ts
// packages/core/src/events/emit.ts
export async function emit(tx: Tx, e: NewEvent): Promise<void>;
```

Called inside the same transaction as the state change (D13). Phase 1 emits: `project.created|updated`, `stage.created|updated|archived`, `label.created|updated|archived`, `work_item.created|updated|archived`, `work_item.stage_changed`, `spec.version_created`, `member.added|role_changed|removed`. The audit view is a filtered read of this table; there is no separate audit log.

---

## 4. Data model changes

Delivered as several migrations, roughly one per step, so a partial phase is still deployable. Types abbreviated; every table has `created_at`, mutable ones have `updated_at`, and all ids are UUIDv7 generated in application code.

```sql
-- 0003_identity.sql
create table orgs (
  id uuid primary key, name text not null, slug text not null unique
);

create table users (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  external_sub text not null unique,          -- Passport claim; the stable identity
  email text, display_name text, avatar_url text,
  last_seen_at timestamptz,
  archived_at timestamptz
);

-- 0004_projects.sql
create table projects (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  key text not null,                          -- 'ACME', used in work item keys
  name text not null,
  description text not null default '',
  owner_user_id uuid references users(id),
  next_item_number integer not null default 1,
  optional_concepts jsonb not null default '{"acceptanceCriteria":false,"visualConfirmation":false}',
  settings jsonb not null default '{}',       -- budgets (P4), loop budget (P5) land here
  archived_at timestamptz,
  unique (org_id, key)
);

create table project_members (
  project_id uuid not null references projects(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('owner','maintainer','member','viewer')),
  primary key (project_id, user_id)
);

create table stages (
  id uuid primary key,
  project_id uuid not null references projects(id),
  key text not null, name text not null,
  position integer not null,
  default_owner_class text not null check (default_owner_class in ('ai','human','external')),
  is_initial boolean not null default false,
  is_terminal boolean not null default false,
  archived_at timestamptz,
  unique (project_id, key)
);
create unique index stages_one_initial on stages (project_id) where is_initial and archived_at is null;

create table labels (
  id uuid primary key,
  project_id uuid not null references projects(id),
  key text not null,                          -- 'risk:high', 'touches:auth'
  name text not null, color text not null default 'gray',
  category text,                              -- 'risk' | 'area' | free text; groups the UI
  agent_settable boolean not null default true,
  archived_at timestamptz,
  unique (project_id, key)
);

-- 0005_work_items.sql
create table work_items (
  id uuid primary key,
  project_id uuid not null references projects(id),
  number integer not null,
  key text not null,                          -- 'ACME-14', denormalised for lookup
  title text not null,
  description text not null default '',
  complexity text check (complexity in ('low','medium','high')),
  current_stage_id uuid not null references stages(id),
  current_stage_instance_id uuid,             -- FK added after stage_instances exists
  current_spec_version_id uuid,
  owner_class text not null default 'human' check (owner_class in ('ai','human','external')),
  externally_blocked_reason text,
  created_by_user_id uuid references users(id),
  version integer not null default 1,         -- optimistic locking
  archived_at timestamptz,
  unique (project_id, number), unique (project_id, key)
);

create table work_item_labels (
  work_item_id uuid not null references work_items(id) on delete cascade,
  label_id uuid not null references labels(id),
  set_by_actor jsonb not null,                -- who/what applied it; agents in P2
  created_at timestamptz not null default now(),
  primary key (work_item_id, label_id)
);

create table spec_versions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  version integer not null,
  content jsonb not null,
  authored_by jsonb not null,                 -- Actor: human in P1, agent in P2
  note text,
  created_at timestamptz not null default now(),
  unique (work_item_id, version)
);

create table status_overrides (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  status text not null, reason text not null,
  set_by_user_id uuid not null references users(id),
  cleared_at timestamptz, created_at timestamptz not null default now()
);

-- 0006_history.sql
create table stage_instances (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  stage_id uuid not null references stages(id),
  seq integer not null,                       -- 1,2,3… across the item's life
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  outcome text,                               -- set in P2 from run/report outcomes
  unique (work_item_id, seq)
);

create table transitions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  from_stage_id uuid references stages(id),   -- null for creation
  to_stage_id uuid not null references stages(id),
  direction text not null check (direction in ('forward','backward','lateral','initial')),
  reason_code text,                           -- taxonomy lands in P5
  note text,
  actor jsonb not null,
  gate_evaluation_id uuid,                    -- P3
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  project_id uuid references projects(id),
  type text not null,
  subject_type text not null, subject_id uuid not null,
  actor jsonb not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz                    -- P8 delivery marker
);
create index events_project_occurred on events (project_id, occurred_at desc);
create index events_subject on events (subject_type, subject_id, occurred_at desc);

-- 0007_infra.sql
create table jobs (
  id uuid primary key, kind text not null, payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','running','done','failed','dead')),
  priority integer not null default 0,
  run_after timestamptz not null default now(),
  attempts integer not null default 0, max_attempts integer not null default 8,
  locked_by text, locked_at timestamptz, last_error text,
  dedupe_key text unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index jobs_claim on jobs (status, run_after) where status = 'pending';

create table feature_flags (
  key text primary key, enabled boolean not null default false,
  enabled_for_project_ids uuid[] not null default '{}',
  updated_by uuid references users(id), updated_at timestamptz not null default now()
);
```

Direction on `transitions` is computed from stage `position` at write time (`to.position > from.position → forward`), so Phase 5 can count backward edges without re-deriving them against a pipeline that may since have been reordered.

---

## 5. Interfaces

### 5.1 Service surface (the only place rules live)

```ts
// packages/core/src/projects
createProject(ctx, { key, name, template: 'default'|'minimal'|'empty' }): Result<Project>
updateProject(ctx, id, patch): Result<Project>
addStage / reorderStages / archiveStage(ctx, …): Result<Stage[]>
upsertLabel / archiveLabel(ctx, …): Result<Label>
addMember / changeMemberRole / removeMember(ctx, …): Result<void>

// packages/core/src/workitems
createWorkItem(ctx, { projectId, title, description?, complexity?, labelKeys? }): Result<WorkItem>
updateWorkItem(ctx, id, patch, expectedVersion): Result<WorkItem, 'stale_version'>
setLabels(ctx, id, { add, remove }): Result<WorkItem>
transitionWorkItem(ctx, id, { toStageId, note?, reasonCode? }, expectedVersion): Result<WorkItem, TransitionError>
archiveWorkItem(ctx, id): Result<void>

// packages/core/src/specs
createSpecVersion(ctx, workItemId, content, note?): Result<SpecVersion>
getSpec(ctx, workItemId, version?): Result<SpecVersion>
```

`transitionWorkItem` in Phase 1 enforces only: the target stage belongs to the item's project and is not archived; the item is not archived; the version matches. Phase 3 inserts gate evaluation into the same function — deliberately, so there is exactly one path through which stage changes happen.

### 5.2 UI surfaces

| Route | Phase 1 content | Grows in |
|---|---|---|
| `/projects` | List, create | — |
| `/projects/[key]/board` | Columns per stage, cards with key/title/complexity/labels/owner class, drag to move | P2–P6 |
| `/projects/[key]/items/[itemKey]` | Header, spec (view/edit, version history), labels, complexity, stage timeline, activity feed | P2–P7 |
| `/projects/[key]/settings` | Pipeline editor, label taxonomy, members | P3–P7 |
| `/projects/[key]/audit` | Filterable event stream | P3–P6 |

Mutations are server actions calling core services; lists are React Server Components. The board's drag interaction is optimistic with rollback on a `Result` error — the same code path that will render "blocked by gate" in Phase 3.

---

## 6. Implementation steps

### Step 1.1 — Database foundation

**Goal.** A schema-first `packages/db` other packages can depend on.

**Changes.** Drizzle schema modules mirroring §4; connection factory (pooled runtime, direct for migrations); `exec-migrations` runner with an advisory lock so concurrent CI runs cannot collide; RLS lockdown migration (`enable row level security` on every table, revoke `anon`/`authenticated`); UUIDv7 helper; repository helpers for pagination and soft-delete filtering; `pnpm db:seed`.

**Done when.** `pnpm db:migrate && pnpm db:seed` produces a working local database, and CI runs migrations on the preview deploy without manual steps.

---

### Step 1.2 — Core service scaffolding and the event outbox

**Goal.** The conventions every later service follows, established once.

**Changes.** `ServiceContext` and `Actor` types; the `Result` helper and error taxonomy; `emit()` plus the `NewEvent` zod schemas in `packages/contracts/src/events`; a transaction helper that fails loudly if a state change is committed without an event (a lint rule plus a test-mode assertion); the `packages/jobs` queue, worker registry, scheduler endpoint, and `CRON_SECRET` check; the feature-flag reader.

**Done when.** A trivial service (`createOrg`) writes its row and its event in one transaction, an integration test proves rollback removes both, and a scheduled no-op job runs on the preview deployment.

---

### Step 1.3 — Identity, membership, authorisation

**Goal.** Requests carry a real actor and permission checks live in one module.

**Changes.** Passport → `users` upsert on first request; `project_members` CRUD; `packages/core/src/authz` with `can(actor, action, resource)` and the matrix from `architecture-baseline.md` §6.3; a `requireProjectAccess` helper for RSC and route handlers; local dev fake-identity path guarded by `assert(!process.env.VERCEL)`; a sign-in-state header component.

**Done when.** A `viewer` cannot mutate anything through any surface, a `maintainer` can, the permission matrix has a unit test per cell, and identity is visible in the UI on the preview deploy.

---

### Step 1.4 — Projects, pipelines, labels

**Goal.** Two structurally different projects can exist.

**Changes.** Project CRUD with template application; stage add/rename/reorder/archive with the single-initial and at-least-one-terminal invariants; label taxonomy CRUD with `category` and `agent_settable`; the settings UI for all three; guardrails (cannot archive a stage holding work items; reordering rewrites `position` in one transaction).

**Done when.** The demo's two projects — different stage sets, different label taxonomies — can be created entirely through the UI, and an integration test asserts no stage key appears anywhere in application code.

---

### Step 1.5 — Work items, labels, complexity

**Goal.** The central object, with a human-readable key.

**Changes.** `createWorkItem` allocating `number` via `UPDATE projects SET next_item_number = next_item_number + 1 RETURNING` inside the transaction; label add/remove recording `set_by_actor`; complexity set/change (emitting an event Phase 4 will listen to for budget defaulting); list and filter queries with keyset pagination; the board and its card component; a quick-create form.

**Done when.** Items can be created, labelled, and filtered in both projects; keys are gap-free per project; and a concurrency test creating 50 items in parallel produces 50 distinct numbers.

---

### Step 1.6 — Specs

**Goal.** Versioned spec content in our database, ready for agents to read in Phase 2.

**Changes.** `spec_versions` service; markdown editor with preview; version history with diff between adjacent versions; `content` validated against the project-resolved schema; byte limits enforced server-side; empty-state copy that does not imply acceptance criteria are required.

**Done when.** A spec can be written, revised three times, and each version viewed and diffed, with authorship and timestamps intact.

---

### Step 1.7 — Transitions, stage instances, derived status

**Goal.** Movement through the pipeline is recorded well enough to audit and to build on.

**Changes.** `transitionWorkItem` closing the current `stage_instances` row and opening the next in one transaction; `direction` computed from positions; `deriveStatus` with its Phase 1 inputs and the growth-ready signature; `status_overrides` with a mandatory reason; the stage timeline component; the audit view.

**Done when.** An item walked Intake → Deploy has one stage instance per visit with correct durations, a backward move is recorded as `direction = 'backward'`, and the audit view reconstructs the item's life from `events` alone.

---

### Step 1.8 — UI shell and polish

**Goal.** A tracker a person can actually use for the demo without coaching.

**Changes.** App shell (nav, project switcher, breadcrumbs); shadcn/ui primitives in `packages/ui`; loading and empty states; keyboard shortcuts for create and search; accessible drag-and-drop with a keyboard fallback; error boundaries rendering `Result` errors as human sentences; light/dark theme.

**Done when.** Someone outside the team completes "create a project, create a ticket, spec it, move it to Deploy" unaided.

---

### Step 1.9 — Test harness and seed data

**Goal.** The safety net every later phase relies on, plus a repeatable demo dataset.

**Changes.** Vitest projects for unit and integration; `docker compose` Postgres wired into integration tests with per-test transactional rollback; typed factories; Playwright configured against `PREVIEW_URL` with the bypass header; a `pnpm db:seed --demo` producing two projects, a label taxonomy each, and a dozen work items at varied stages; a CI-visible coverage summary for `packages/core`.

**Done when.** `pnpm test` runs unit, integration, and (given a preview URL) end-to-end suites; the seed produces the demo dataset in one command.

---

### Step 1.10 — Flag removal and hardening

**Goal.** Phase 1 is genuinely finished rather than merged.

**Changes.** Remove `p1.*` flags; add indexes revealed by the query patterns; add a `/api/health` check for queue depth and oldest pending job; write `docs/runbook.md` §"Phase 1 surfaces"; re-read the Phase 2 plan against what was actually built and amend it.

**Done when.** No Phase 1 flag remains and the board renders a 200-item project without an N+1 query.

---

## 7. Testing and verification

- **Unit.** `deriveStatus` truth table; transition direction computation; work item key allocation; authorisation matrix; spec schema validation including oversize rejection.
- **Integration.** Every service against real Postgres: transactional event emission and rollback; optimistic-lock conflicts; stage instance open/close invariants; the single-initial-stage constraint; cross-project isolation (a `viewer` on project A gets 404, not 403, on project B's items — do not leak existence).
- **Property test.** Random sequences of transitions never produce overlapping open stage instances and never leave `current_stage_instance_id` dangling.
- **End-to-end.** The demo script (§9) automated in Playwright against the preview URL.
- **Performance smoke.** Board and item list under 500 ms server time with 1,000 work items in a project.

## 8. Rollout and safety

- Flags `p1.projects`, `p1.workitems`, `p1.specs` — enabled per project during the phase, removed in step 1.10.
- Migrations are additive; the only destructive statement is dropping the Phase 0 spike tables, which Phase 0 step 0.9 already merged.
- Seeded template pipelines are copied, never referenced, so editing a template cannot mutate live projects.
- No agent, cost, or gate code exists yet, so there is no spend risk in this phase.

## 9. Demo script (the proof)

1. **Two shapes.** Create project **Alpha** from the Default template (six stages) and project **Beta** from Minimal, then hand-edit Beta's pipeline to add a "Design" stage between Intake and Implementation. Show Alpha's `risk:*` / `touches:*` taxonomy alongside Beta's entirely different labels.
2. **A ticket's life.** In Alpha, create "Add SSO to the admin console", set complexity to High, apply two labels, write a spec, revise it twice, and show the version diff.
3. **Through the pipeline.** Move it stage by stage to Deploy, including one deliberate move backwards from Review to Implementation.
4. **History.** Open the stage timeline: one row per visit with durations, the backward edge visible. Open the audit view: every change with actor and timestamp, reconstructed from events.
5. **Nothing is hardcoded.** Rename Alpha's "Review" stage to "Verification" and reorder two stages; show the board, the timeline, and the history all following, with no deploy.
6. **Access control.** Sign in as a `viewer`; show mutations are unavailable in the UI and refused by the server.

## 10. Risks and mitigations

| Risk | Signal | Mitigation |
|---|---|---|
| Stage semantics leak into code | A `switch` on a stage key appears in a PR | ESLint rule banning stage-key string literals outside seed/templates; a test that greps for the default keys |
| Spec schema over-specified early | Debates about required spec fields | The schema has one required field (`summary`); everything else is optional until a project opts in |
| Event payloads churn later | Phase 8 wants to change Phase 1 payload shapes | Payload schemas are versioned from the first event; additive changes only after Phase 8 |
| Board becomes the product | UI work expands past the step | The board is a runtime view; the inbox is Phase 6 and the policy surface is Phase 3 |
| Optimistic locking rejected as friction | "Why did my edit fail?" | Conflicts surface as a merge prompt showing what changed, not a raw error |
| Untested migrations against production data shape | A migration works locally, fails on preview | Every migration PR runs against a preview database seeded to demo scale before merge |

## 11. Exit criteria

- [ ] Two projects with different pipelines and different label taxonomies exist and behave correctly.
- [ ] A work item can be created, complexity set, labelled, specced across multiple versions, and moved to the terminal stage.
- [ ] Stage instances record every visit with accurate durations; transitions record direction and actor.
- [ ] The audit view reconstructs an item's full history from `events`.
- [ ] `deriveStatus` is the only source of displayed status; overrides are recorded as overrides.
- [ ] Authorisation is enforced in one module and covered cell-by-cell by tests.
- [ ] Job queue and scheduler run on the preview deployment.
- [ ] Seed produces the demo dataset in one command; Playwright walks the demo script.
- [ ] No stage key or label key appears as a literal in application logic.
- [ ] Phase 1 flags removed.

## 12. Open questions for this phase

- **Q6** — whether `ci-required` runs our test scripts. Until answered, treat green CI as insufficient and run `pnpm test` locally before merge.
- **Q12** (role matrix) — Phase 1 implements the proposed default; only the "who may raise a budget cap" cell is genuinely open, and it does not bite until Phase 4.
- **Local:** should work items support parent/child or dependency links in the PoC? `VISION.md` §4.2 says "optional for PoC if simple; defer graph sophistication". Recommendation: add a nullable `parent_work_item_id` in Phase 1 for grouping only, and defer dependency semantics entirely.
