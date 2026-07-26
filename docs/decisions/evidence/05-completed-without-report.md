# Phase 0 evidence — failure demo `completed_without_report` (2026-07-26)

## Setup

- Preview: `https://nexus-hszz7o1se.internalsphere.com` (sha `f79cef1…`).
- Launch body: `{ ticketId, adapter: "cloud_agent", scenario: "no_mcp" }`.
- Prompt instructs the agent **not** to call MCP; MCP server still injected (available but unused).

## Run

| Field | Value |
|---|---|
| ticket | `d3a3e797-cb22-4786-b492-0dbd0e069510` |
| run | `60022ab6-9537-4619-a971-a7009a361778` |
| agent | `bc-593df2c2-91e3-4ff2-b45d-a1ba0ea5b191` |
| external run | `run-d3a8cb8d-4874-4448-9599-85ae8be8f298` |
| DB status after poll | **`completed_without_report`** |
| durationMs | 5595 |
| tokens | `totalTokens: 15031` (usage still fetched) |
| error | null |

## Detection

`packages/jobs/src/handlers/spike-poll-run.ts`: on provider terminal `finished`/`completed`, if no `spike_reports` row matches `run.nonce`, status is rewritten to `completed_without_report`.

## Demo pick

This is the instructive Phase 0 failure case: provider success ≠ our success.
