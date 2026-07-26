# ADR-0005 — Failure-mode matrix (Phase 0)

## Status

Accepted for the demo-critical rows; remaining rows noted as design expectations or API probes.

## Matrix

| # | Scenario | Observed | Detection / recovery |
|---|---|---|---|
| 1 | MCP endpoint 500 mid-tool | Not live-forced | Poller: terminal + missing/invalid report → `completed_without_report` or failed |
| 2 | Run token expires mid-run | Not live-forced | MCP auth error; treat as failed tool; same no-report detection |
| 3 | Agent never calls MCP | **Live:** `completed_without_report` (`05-completed-without-report.md`) | Terminal + no `spike_reports` for nonce → rewrite status |
| 4 | Cancel a running run | `POST …/cancel` → **500 internal** (probes) | Do not trust cancel; deadline watchdog + status poll |
| 5 | Second run while active | `409 agent_busy` | Map to `provider_busy`; queue or reject at launcher |
| 6 | Poller misses terminal (cron gap) | Terminal state still returned on later `GET run` | Idempotent poll handler |
| 7 | SSE after retention | Fixture `410 stream_expired`; live SSE is non-JSON | Fall back to `GET run` (D7) |
| 8 | Bypass header omitted | **Live:** HTTP **302** Redirecting… on `/api/health` | Passport edge block confirmed |
| 9 | Malformed report | Zod rejection in spike tools | MCP tool error payload |
| 10 | Cursor API 429 | Client retries with backoff (unit-tested) | Launch fails visibly after retries |

## Additional API findings

- `model` must be `{ id }` when provided (`03-api-failure-probes.md`).
- Replay `agentId` → `409 agent_id_conflict`.

## Demo pick

Scenario 3 — proven live with `scenario: "no_mcp"` launch.
