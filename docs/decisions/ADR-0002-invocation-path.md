# ADR-0002 — Invocation path (Phase 0)

## Status

**Accepted** for Spike A (Cloud Agents API). Spike B (automation webhook) deferred — no hand-authored Nexus automation (Q4); see `06-spike-b-blocker.md`.

## Decision

Primary invocation path is **direct Cloud Agents API** (`POST /v1/agents` with client-supplied `agentId`, injected `mcpServers[]`). Automation webhook remains a secondary adapter behind the same port.

## Evidence

- Service-account key creates no-repo agents and agents on `internalsphere/nexus` (`00-preconditions.md`).
- Deterministic `agentId` (`bc-<uuid>`) returns `409 agent_id_conflict` on replay (`03-api-failure-probes.md`).
- One active run per agent enforced via `409 agent_busy`.
- **Live MCP happy path proven** — agent posted `spike_reports`, poller recorded terminal + tokens (`04-spike-a-live.md`).
- Spike B blocked on missing webhook automation (`06-spike-b-blocker.md`).

## Consequences

- Confirms D5 for the API path including MCP E2E.
- Phase 2 must treat “terminal without report” as a first-class outcome (live: `05-completed-without-report.md`).
- Keep the webhook adapter; Spike B remains a Phase 2 dependency on Q4.
