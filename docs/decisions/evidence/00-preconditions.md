# Phase 0 evidence — preconditions (2026-07-26)

## Credentials present in cloud agent environment

| Secret / env | Status |
|---|---|
| `CURSOR_SERVICE_ACCOUNT_KEY` → synced as `CURSOR_API_KEY` | Works against `GET /v1/me` (Basic + Bearer). Key name: `cloud-agent`. |
| `NEXUS_VERCEL_BYPASS` → synced as `VERCEL_PROTECTION_BYPASS` | Present (32 chars). Not yet exercised against a preview URL (deploy pending DB). |
| `CURSOR_ADMIN_API_KEY` | `POST /teams/filtered-usage-events` → `401 Invalid Team API Key`. Reconciled `chargedCents` unavailable until a valid team Admin API key is provided. |
| `GH_TEST_PAT` | Authenticated as `urmade`. Can read `urmade/nexus-test-one` and `urmade/nexus-test-two`. |

## Repository access for Cloud Agents

| Repo | Result |
|---|---|
| `urmade/nexus-test-one` | `400 repository_access` — Cursor GitHub App not installed / not associated with the team. |
| `urmade/nexus-test-two` | Same expectation (not re-tried after one failed). |
| `internalsphere/nexus` | `201` create agent succeeded. |
| No-repo agent | `201` create + run reached `FINISHED` in ~11s (`bc-604332a3-…`, `run-5d235ec1-…`). |

**Q3 answer (provisional):** use `https://github.com/internalsphere/nexus` with `autoCreatePR: false`, or no-repo agents for MCP-only spikes. Install Cursor GitHub App on `urmade/nexus-test-*` if those remain the intended sandboxes.

## Encrypted secrets committed

Via `python3 scripts/secrets.py add --scope shared`:

- `CURSOR_API_KEY`, `VERCEL_PROTECTION_BYPASS`, `SPIKE_ADMIN_TOKEN`, `MCP_TOKEN_SIGNING_KEY`, `CRON_SECRET`, `P0_SPIKE`, `SPIKE_SANDBOX_REPO`, `SPIKE_USE_REPO`, `SPIKE_RUN_CAP`
