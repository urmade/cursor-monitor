# Phase 0 evidence — Spike B (automation webhook) blocker (2026-07-26)

## Attempt

- `cursor-cloud-list-automations` with query `nexus` → **0** matches (1524 team-visible automations scanned for that query).
- Query `spike` matches only unrelated cost-alert automations (cron + Databricks), not a Nexus webhook automation.
- Encrypted secrets do not include `SPIKE_AUTOMATION_WEBHOOK_URL` / `SPIKE_AUTOMATION_KEY`.
- Launch adapter `automation_webhook` correctly fails closed when those env vars are missing (`launch.ts`).

## Blocker

Q4: no hand-authored Nexus automation with a webhook trigger + MCP config for this spike.

## Decision impact

- Primary path remains Cloud Agents API (ADR-0002).
- Spike B deferred to Phase 2 when a real automation exists; webhook adapter code stays as a port.
- Do not invent a stand-in automation for Phase 0 exit — document the gap instead.
