# Phase 0 evidence — Cloud Agents API failure probes (2026-07-26)

Live probes against `https://api.cursor.com` with service-account key `cloud-agent`. No MCP reachability required.

## Model field shape

| Request | Result |
|---|---|
| `"model": "composer-2"` (string) | `400 validation_error` — `Expected object, received string` |
| `"model": { "id": "composer-2" }` | `201` |
| omit `model` | `201` (API picks a default; run reached `FINISHED`) |

`packages/cursor-client` now normalises string `model` values to `{ id }` before send.

## Idempotency / concurrency

| Scenario | Result |
|---|---|
| Re-POST same `agentId` (`bc-<uuid>`) | `409 agent_id_conflict` — `An agent with this agentId already exists.` |
| `POST /v1/agents/{id}/runs` while a run is `RUNNING` | `409 agent_busy` — `Agent already has an active run` |

## Cancel

| Call | Result |
|---|---|
| `POST …/runs/{runId}/cancel` on a `RUNNING` no-repo agent | `500 { "code": "internal", "message": "Error" }` (reproduced twice) |
| Subsequent `GET …/runs/{runId}` | Still `RUNNING` for ≥30s after the failed cancel |

**Implication.** Cancel cannot be relied on for the Phase 0 demo until the provider path is fixed or we get a non-500 response. Spike cancel endpoint should surface provider errors honestly.

## Usage after terminal

`GET /v1/agents/{id}/usage?runId=…` after `FINISHED` returns `cost.rawCostCents` + `cost.chargedCents` and token totals (see also `01-usage-api.md`). Available without Admin API.

## Stream

`GET …/runs/{runId}/stream` returns a non-JSON body (SSE). Client fixture coverage for `410 stream_expired` remains; live stream expiry not re-proved in this session.

## MCP / edge scenarios (blocked)

Scenarios 1–3, 8–9 in the Phase 0 matrix need a reachable deployment (`*.internalsphere.com` egress). See `02-egress-blocker.md`.
