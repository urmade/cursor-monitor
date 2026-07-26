# ADR-0007 — Cost data availability (Phase 0)

## Status

Accepted.

## Decision

Prefer **`GET /v1/agents/{id}/usage`** for per-run tokens and `chargedCents` / `rawCostCents`. Do not block Phase 4 on the Enterprise Admin API `filtered-usage-events` endpoint.

## Evidence

- Usage endpoint returns `cost.chargedCents` for finished no-repo runs (`01-usage-api.md`, `03-api-failure-probes.md`).
- `CURSOR_ADMIN_API_KEY` → `401 Invalid Team API Key` for `POST /teams/filtered-usage-events`.

## Consequences

- Phase 4 can show provider-reported charges for cloud-agent runs without Admin API.
- Admin reconciliation remains optional if a valid team Admin key appears later.
- Estimates still need a price table (Q8); label UI until we trust the gap vs `chargedCents`.
