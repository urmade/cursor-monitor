# Phase 0 evidence — Spike A live MCP loop (2026-07-26)

## Preview

- Branch `cursor/phase-0-skeleton-36eb` @ `96c2541` (happy path) / `f79cef1` (failure scenario code).
- Happy-path host: `https://nexus-hnm7mpd7z.internalsphere.com` (sha `96c2541…`).
- Auth: `x-vercel-protection-bypass` + `SPIKE_ADMIN_TOKEN` / `CRON_SECRET`.

## Happy path (`scripts/spike-demo.sh`)

| Step | Result |
|---|---|
| `GET /api/health` | `ok`, db `ok`, migration `0001_spike` |
| `POST /api/spike/seed` | ticket `0464fddf-29ad-4762-8499-3917b6485156` |
| `POST /api/spike/launch` `cloud_agent` | run `6f1c99ff-4bac-4656-979b-f2fbcfc0bbca`, agent `bc-325b268b-4484-4660-a3e7-5ce6aae0936c`, run `run-e6750adb-4e5f-45b1-b1af-feddfd1cd681` |
| Agent MCP | Called `spike_get_ticket` + `spike_post_report`; report_id `89143785-0b43-4b33-995d-bc6d8be8cb8c` |
| Poller / cron tick | Terminal status `finished` in DB |
| Duration | `durationMs: 12352` |
| Usage | `totalTokens: 60188`, `chargedCents: 8.084276` |

Agent result text (redacted): reported ticket id, echoed nonce `db7c7684c98346c7b4d26c05f79f5ecc`, `ok: true` on report post.

## Answers to step 0.4 questions

1. **Injected MCP discovery without repo config?** Yes — no-repo agent (`SPIKE_USE_REPO=false`) used injected `mcpServers`.
2. **Bypass + bearer forwarded?** Yes — tools succeeded against Passport-protected host.
3. **Latency create → terminal?** ~12s wall for this run (`durationMs` 12352).
4. **`409 agent_id_conflict`?** Previously confirmed in `03-api-failure-probes.md` (not re-run here).
5. **Run poll statuses?** `FINISHED` with `result` text; poller persisted tokens.
6. **Usage at terminal?** Immediate — first poll after finish included `chargedCents` + token breakdown.
