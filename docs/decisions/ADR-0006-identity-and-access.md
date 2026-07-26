# ADR-0006 — Identity and access (Phase 0)

## Status

Accepted for the PoC shape.

## Decision

| Principal | Credential | Enforcement |
|---|---|---|
| Human (browser) | Passport via `x-vercel-oidc-passport-token` (edge-verified) | Decode claims; require `external_sub`. Local fallback only when `!VERCEL`. |
| Cursor agent (MCP) | Per-run bearer + `x-vercel-protection-bypass` | Token scoped to run/ticket; bypass only on server-injected MCP headers (ADR-0004). |
| Cron | `CRON_SECRET` / Vercel cron auth on `/api/cron/tick` | Reject unauthenticated ticks. |

Role matrix for product authz (owner/maintainer/member) is deferred to Phase 1 schema.

## Evidence

- `src/server/identity.ts` kept after spike teardown.
- Without bypass, preview `/api/health` returns HTTP 302 (Passport) — `02-egress-blocker.md`.
- With bypass + run bearer, agent MCP tools succeeded — `04-spike-a-live.md`.
- Disposable `/spike/whoami` and `SPIKE_ADMIN_TOKEN` routes removed in step 0.9.

## Consequences

- Closes the Phase 0 identity sketch for code structure.
- Machine-token family split (run-scoped MCP vs long-lived automation) matches D6 / ADR-0004.
