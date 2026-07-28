# Nexus public event catalogue

Frozen in Phase 8. Compatibility rules:

- Adding an optional field to `data` is **not** breaking.
- Removing or retyping a field is breaking and requires a new `type@version`.
- Consumers must ignore unknown fields.

## Envelope

Every delivered webhook uses the same envelope:

```json
{
  "id": "evt_01J…",
  "type": "work_item.stage_changed",
  "version": 1,
  "occurred_at": "2026-07-25T18:29:00.000Z",
  "project": { "id": "…", "key": "ACME" },
  "subject": { "type": "work_item", "id": "…", "key": "ACME-14" },
  "actor": { "kind": "agent", "run_id": "…" },
  "data": {}
}
```

## Event types

### work_item.created

Emitted when a work item is created.

### work_item.updated

Emitted when title, description, complexity, or labels change.

### work_item.stage_changed

Emitted on pipeline transitions.

### work_item.status_changed

Emitted when derived status changes.

### spec.version_created

Emitted when a new spec version is stored.

### run.started

Emitted when a run enters `running`.

### run.finished

Emitted when a run reaches a terminal state with a report path.

### stage_report.posted

Emitted when `post_stage_report` succeeds.

### question.asked

Emitted when a question is opened.

### question.answered

Emitted when a question receives an answer.

### gate.evaluated

Emitted after gate evaluation completes.

### approval.decided

Emitted when an approval is approved or rejected (internal `approval.approved` / `approval.rejected`).

### budget.threshold_crossed

Emitted when soft budget thresholds are crossed.

### budget.blocked

Emitted when spend is blocked by a hard budget.

### loop.detected

Emitted when a return edge is recorded.

### loop.escalated

Emitted when a loop is escalated for human attention.
