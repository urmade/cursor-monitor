# Phase 0 evidence — usage & cost (2026-07-26)

## Probe: no-repo agent

- Agent: `bc-604332a3-4e0a-4211-ba89-f6ab95c1605c`
- Run: `run-5d235ec1-254b-4b99-a154-d9fe9c2f0ce8`
- `GET /v1/agents/{id}/runs/{runId}` → `status: FINISHED`, `durationMs: 3684`, `result: "pong"`

## `GET /v1/agents/{id}/usage?runId=…` (service account)

Returned promptly after terminal (probed minutes later; also available soon after finish in practice):

```json
{
  "totalUsage": {
    "inputTokens": 14286,
    "outputTokens": 408,
    "cacheWriteTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 14694
  },
  "cost": {
    "rawCostCents": 5.70775,
    "chargedCents": 4.018675
  },
  "runs": [
    {
      "id": "run-5d235ec1-254b-4b99-a154-d9fe9c2f0ce8",
      "usageUuid": "b69c1a10-30c8-5114-a0df-aa9f91f8dc48",
      "usage": { "inputTokens": 14286, "outputTokens": 408, "totalTokens": 14694 },
      "cost": { "rawCostCents": 5.70775, "chargedCents": 4.018675 }
    }
  ]
}
```

**Implication for D12 / Phase 4:** the Cloud Agents usage endpoint already exposes per-run `chargedCents` (and `rawCostCents`) for this service account — reconciled-looking charges may not require the Enterprise Admin API for cloud-agent runs.

## Admin API

`POST /teams/filtered-usage-events` with `CURSOR_ADMIN_API_KEY` → `401 Invalid Team API Key`.

Treat Admin API reconciliation as unavailable until a valid team-scoped Admin key is issued; prefer `/v1/agents/{id}/usage` cost fields when present.
