# ADR-0003 — Observation strategy (Phase 0)

## Status

Accepted (polling). SSE opportunistic only.

## Decision

Observe runs via cron-driven polling of `GET /v1/agents/{id}/runs/{runId}`, then `GET /v1/agents/{id}/usage?runId=…` at terminal. Do not depend on provider webhooks or long-lived SSE for correctness.

## Evidence

- Polling returns durable terminal status after finish (`01-usage-api.md`, `03-api-failure-probes.md`).
- Usage (including `chargedCents`) is available on the Cloud Agents usage endpoint promptly after terminal.
- Cancel currently returns provider `500` and does not transition the run — poller/watchdog must still detect stuck `RUNNING` states by deadline, not by cancel success.
- Vercel cannot hold SSE; stream endpoint is non-JSON (SSE). Fixture covers `410 stream_expired`.

## Consequences

- Confirms D7.
- Phase 2 stuck-run sweep remains mandatory; cancel is best-effort until the provider path is reliable.
