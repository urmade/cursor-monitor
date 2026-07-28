# Access control (PoC final — Phase 9 / Q12)

Authorisation lives in `packages/core/src/authz`. Adapters (UI, MCP, REST, jobs)
must not invent their own allow/deny rules.

## Roles

| Role | Intent |
|---|---|
| `viewer` | Read project, items, specs, runs, audit, analytics |
| `member` | Create/update/transition items; answer questions; decide approvals; launch/cancel runs |
| `maintainer` | Configure pipeline, labels, bindings, gates; archive items; override status/gates |
| `owner` | Everything maintainer can do, plus archive the project |

The generated matrix in `packages/core/src/authz/matrix.ts` is the source of truth.
`matrix.test.ts` asserts `can()` against every cell, and asserts every `AuthzAction`
(except org-only create actions) appears in `PROJECT_SCOPED_ACTIONS` so a new action
cannot land without matrix coverage.

## Surfaces

| Surface | AuthN | AuthZ |
|---|---|---|
| UI (Passport / local-dev) | OIDC JWT or local fallback | Project membership role → `can()` |
| MCP | Per-run bearer token | Agent allow-list + work-item scope on the token |
| Public API `/api/v1` | Project API token | Scope → action map + hard project id bind |
| Jobs / cron | System actor | Trusted; must still scope queries per org |

## Cross-project isolation

- API tokens are minted for one `project_id`. `can()` denies any resource whose
  `projectId` differs, regardless of scopes.
- MCP run tokens are bound to one `workItemId`. Tool handlers return `forbidden`
  when `ticket_id` mismatches.
- Human membership is per project; absence of a role yields **404 not 403** on
  reads so resource existence is not leaked (`getWorkItem`, `getProjectByKey`,
  `estimateForNewItem`, `projectAnalytics`).

## Token / service-account inventory (PoC)

| Kind | Lifetime | Scope |
|---|---|---|
| MCP run token | Run lifetime | Single work item |
| API project token | Until revoked / expiry | Listed scopes on one project |
| Cron `CRON_SECRET` | Long-lived env | Tick endpoint only |
| Cursor API key | Org secret | Provider calls from our backend |

## Rate limits

Public API enforces per-token rate limits (`enforceRateLimit` in
`apps/web/src/server/api-v1`). MCP writes use Redis/memory rate-limit helpers in
`packages/core/src/redis/rate-limit.ts`. Inbox actions are session-authenticated
and gated by `can()` on the underlying action.
