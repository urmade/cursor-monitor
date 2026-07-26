# Phase 0 evidence — egress (updated 2026-07-26)

## Earlier blocker (superseded)

The previous cloud-agent VM could not open `*.internalsphere.com` (TLS reset after Client Hello). That environment used a restricted egress allowlist without `*.internalsphere.com`. Evidence from that session remains historically true for that VM; it does **not** apply to the current environment.

## Current environment

| Check | Result |
|---|---|
| `cursor-cloud-environment-info` egress | `restricted: false`, `egressMode: allow_all` |
| `curl https://example.com` | HTTP 200 |
| `curl` + bypass → `https://nexus-*.internalsphere.com/api/health` | JSON health (`ok`, `sha`, `db`, `migrationVersion`) |
| `curl` **without** bypass → same `/api/health` | HTTP **302** Redirecting… (Passport still enforced) |
| Injected MCP from Cursor cloud agent | **Works** — see `04-spike-a-live.md` |

## Implication

- Network reachability to Internalsphere hosts is unblocked for this agent environment and for child cloud agents used in Spike A.
- Passport protection remains intentional: clients must send `x-vercel-protection-bypass` (synced secret `VERCEL_PROTECTION_BYPASS` / injected `NEXUS_VERCEL_BYPASS`).
- ADR-0004 is now live-proven; D6 stands.
