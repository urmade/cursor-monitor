# PoC results — Nexus (Phase 9 / M5)

Prepared for an independent go/no-go decision. Figures below are from local
fresh-database runs of the Phase 9 suite and the acceptance fixture; preview
numbers will differ with real Cursor spend.

## What was proven

1. **Project control plane** — stages, labels, complexity budgets, project burn
   cap are configurable and enforced (`packages/core` + UI).
2. **Gates** — deterministic field rules and human approval gates block without
   mutating stage; agentic Pass/Warn/Block path exists (Phase 7) behind a model
   provider.
3. **Automation bindings + audited runs** — launch with ticket id, poll, cost
   capture (Phase 2/4). Live Cursor API exercise needs `CURSOR_API_KEY`.
4. **MCP fetch/update/report** — agents scoped to one work item; labels feed
   later gates.
5. **Inbox** — answer questions and decide approvals without hand-editing status.
6. **Loops** — return edges, journey ribbon, rework cost attribution.
7. **Deploy terminal** — default template ends at Deploy; nothing launches after.
8. **Cost range estimates** — quantile estimator with honest cold start, creation
   snapshot, and a walk-forward backtest that **can report poor coverage** (not
   only confirm success). Thin analytics exist; see honesty notes below.

## Measured figures (local acceptance / tests)

| Metric | Observation |
|---|---|
| Cold start | Projects with &lt;5 comparable completed items (tiers 1–2) or &lt;8 (tier 3) show complexity default + explicit basis and the threshold for the rung in play |
| Min n (Q11) | Tier 1–2: **5**; tier 3 (org + pipeline shape): **8** |
| Backtest | Harness recovers coverage/bias/MAPE; synthetic regime-change history → coverage &lt;65% + “too narrow” / bias copy. Empty samples say the estimator was never evaluated — not “0% coverage” |
| Analytics | Live path median spend matches hand query on terminal items; human-touch median includes zero-touch items. `analytics_daily` is yesterday-only; incomplete “today” rows are not served as truth |
| Access matrix | Generated suite covers every project-scoped `AuthzAction` × role cell **and** asserts every `AuthzAction` is registered (reverse check) |

## Honesty corrections (post independent review)

Earlier drafts of this file over-claimed. Correcting the record:

- **“Analytics that reconcile”** — live `computeProjectMetrics` reconciles with
  hand queries on the same window **after** zero-touch human-touches and
  terminal filtering. The five SQL views are a second definition; until the
  job reads them exclusively, dual-definition drift remains a known risk.
- **“Jobs (org-scoped)”** — nightly analytics loops **every org**. Backtests
  with a `projectId` resolve that project’s org only (system actor must not
  write onto other tenants). Estimate cache keys include `orgId`.
- **§9.6 “walked twice”** — the deterministic Playwright suite exercises
  fixture project list, analytics, and board estimate preview after
  `pnpm acceptance:setup`. Full VISION §16 live-agent steps were **not**
  walked in this environment (no `CURSOR_API_KEY` / model credentials). No
  separate observation log beyond the suite output and this table.
- **Admin page** — not shipped; deviation recorded in the phase-09 plan.

## What was not proven in this environment

- Live Cursor agent run end-to-end (no `CURSOR_API_KEY` in the agent VM).
- Live agentic rubric evaluation against a real model provider (no model credential).
- Production-scale estimate accuracy (PoC history is seeded, not organic).
- End-to-end §16 walkthrough with a human operator on a clean preview deploy.

## Known gaps / operational limits

- Estimates never auto-set budgets (deliberate).
- No automatic widening when backtest coverage is poor — report and decide.
- Analytics are nightly (`analytics_daily` for complete UTC days) with live
  fallback; not a BI product. UI “Yesterday” can hit the daily path; 7/30/90
  usually stay on live until backfill catches up.
- Feature flags `p9.estimates` (and prior `pN.*`) remain until a cleanup pass —
  architecture baseline §9 flags as debt.
- Migration numbers on this stack skip `0016`/`0017` (Phase 8 landed as `0018`);
  Phase 9 starts at `0019`; review fixes add `0020`.
- Tier-3 basis must not claim “in your project” — items may be org-wide.
- Ticket header shows **estimate at creation** (historical); current estimate is
  a separate request.

## Expansion backlog recommendation (grounded)

Prioritise in this order based on PoC friction, not original vision ordering:

1. **Remove feature-flag debt** and harden preview identity — every phase left flags on.
2. **Trust / progressive autonomy** only after organic estimate backtests stay near 80% coverage for a pilot team.
3. **Intervention→rule effect measurement** — data is already collected; cheap win.
4. Model leaderboards — defer; price table + cost honesty matters more than comparing models yet.
5. Cross-org benchmarking — still not planned.
6. Route analytics exclusively through `security_invoker` views (kill dual definitions).

## Go / no-go

**Conditional go** for a single pilot team: the control-plane thesis holds
locally and the estimator instrumentation now fails closed on authorisation and
cache tenancy; live Cursor and model credentials must be confirmed on preview
before calling M5 closed in production.
