# ADR-0004 — MCP auth (Phase 0)

## Status

**Accepted — live proven** (2026-07-26).

## Decision

Inject MCP per run: `mcpServers: [{ name, type: 'http', url, headers: { Authorization: Bearer <run-token>, x-vercel-protection-bypass } }]`. Run tokens are random secrets stored as SHA-256 hashes, scoped to `(runId, ticketId)`, short-lived, and revoked when the run reaches terminal.

## Evidence

- Bypass secret present and synced (`VERCEL_PROTECTION_BYPASS`) — `00-preconditions.md`.
- Spike minted tokens (SHA-256 hashed, scoped to run/ticket) and attached both headers at launch (removed in 0.9 teardown; pattern documented here).
- **Live proof:** no-repo cloud agent called `spike_get_ticket` and `spike_post_report` on `https://nexus-hnm7mpd7z.internalsphere.com/api/mcp` — `04-spike-a-live.md`.
- Without bypass header, `/api/health` returns HTTP 302 (Passport) — `02-egress-blocker.md` (updated).

## Consequences

- Confirms D6 with end-to-end evidence.
- Phase 0 exit criterion “agent read/wrote via MCP” is **met** for the Cloud Agents path.
- Automation-webhook adapter still needs a static project token when Spike B runs (`06-spike-b-blocker.md`).
