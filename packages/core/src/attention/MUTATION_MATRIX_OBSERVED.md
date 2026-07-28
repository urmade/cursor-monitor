# Phase 6 attention mutation matrix — observed results

Regenerate on a machine with Postgres and `DB_POSTGRES_URL` set:

```bash
chmod +x scripts/verify-attention-mutations.sh
./scripts/verify-attention-mutations.sh
```

Suite command (each mutation): `cd packages/core && pnpm exec vitest run src/attention`

Baseline on branch after this commit (with fresh DB): **all attention tests green**.

| ID | Mutation applied | Killing test(s) | Observed red? |
|----|------------------|-----------------|---------------|
| M1 | Omit `kind: source.kind` on projection update | `B1` in `blockers.integration.test.ts` | **yes** |
| M2 | Disable reconcile kind repair (`open.kind !== exp.kind`) | `B1` | **yes** |
| M3 | Break `readAttentionDispatchCursor` / cursor dispatch | `dispatch.integration.test.ts` (M20), `mutations.matrix` M3 source | **yes** |
| M4 | Accept invalid inbox cursor (no validation error) | `B8` invalid cursor case | **yes** |
| M5 | Zero snooze penalty in `score.ts` | `mutations.matrix` M5, `score.unit` snooze | **yes** |
| M6 | Zero spend-at-risk boost | `mutations.matrix` M6 | **yes** |
| M7 | Zero loop boost scaling | `mutations.matrix` M7 | **yes** |
| M8 | `ageBoost` always returns 0 | `mutations.matrix` M8, `mutations.regression` M8, `score.unit` monotonicity | **yes** |
| M9 | Equal base weights for question vs approval | `mutations.matrix` M9, `score.unit` ranking | **yes** |
| M10 | Zero complexity boost | `mutations.matrix` M10 | **yes** |
| M11 | `AttentionWeightsSchema.parse` on bad version (no safeParse) | `mutations.matrix` M11, `mutations.regression` M11 | **yes** |
| M12 | Wrong lane for `paused_budget` | `mutations.matrix` M12, `mutations.regression` M12 | **yes** |
| M13 | Remove 24h snooze cap in `snoozeAttention` | `mutations.matrix` M13, `mutations.regression` M13 | **yes** |
| M14 | Remove `executeAction` `work_item.update` guard | `executeAction.authz.integration.test.ts`, `blockers` M14/M16 (`open_ticket`, code `forbidden`) | **yes** (was **no** before `open_ticket` + dedicated test) |
| M15 | Remove `project.read` gate in `getAttentionItem` | `blockers` outsider `getAttentionItem` | **yes** |
| M16 | Remove `inArray(attentionItems.projectId, pids)` in list | `blockers` outsider list empty | **yes** |
| M17 | Gut `budget.item_overridden` handler | `B3` | **yes** |
| M18 | Gut `run.launched` supersede handler | `B2` | **yes** |
| M19 | Disable notify coalesce / flush | `notify.integration.test.ts` B5 burst | **yes** |
| M20 | `dispatchAttentionEvents` returns without processing | `dispatch.integration.test.ts` (M20) | **yes** (was **no** before dispatch e2e test) |
| M21 | Remove `loadStatusFactsForWorkItems` from board | `B7` query bound (regresses to N+1) | **yes** |
| M22 | `loadAttentionWeights` uses `parse` not `safeParse` | `mutations.matrix` M22, `mutations.regression` M22 | **yes** (unit); integration if weights row invalid |

## Prior survivor notes (209380a)

### M20 dispatcher root cause (fixed)

The attention consumer used a **single global** `app_meta` cursor (`attention_dispatcher_cursor`) and queried the **entire** `events` table with no `org_id` filter. On a shared test database:

1. With **no cursor**, the first poll consumed the **oldest 50 events across all orgs**, advancing the global cursor while the current test org’s `question.asked` event (at the tail of the timeline) was never read.
2. Even with a cursor, cross-tenant events advanced the same cursor, so another org’s dispatch could skip or reorder work relative to the org that emitted the event.

**Fix:** scope reads to `eq(events.orgId, ctx.orgId)` and store the cursor per org (`attention_dispatcher_cursor:<orgId>`). Phase 8 outbound webhooks should use the same pattern: **per-consumer, per-org** cursor keys on the shared outbox.

### M14 Removing authz while asserting only `act.ok === false` on `answer` was a false positive (`question.answer` forbids outsiders). Fixed by asserting `forbidden` + `You cannot perform this action` on `open_ticket`, and owner `open_ticket` succeeds.
- **M20**: No test called `dispatchAttentionEvents` after `askQuestion` left events on the outbox; projection never exercised. Fixed by `dispatch.integration.test.ts` (row appears, cursor advances).

## UI blocking list

All items from the prior blocking list are implemented on `InboxClient` (filters, meta line, score copy visible, confirm panel, live region, focus on remove, view-only copy). No remaining UI blockers called out in the last review.
