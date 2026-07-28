# Condition DSL

Versioned JSON AST evaluated in-process against a gate context snapshot. Envelope: `{ "v": 1, "ast": … }`. No expression strings, no `eval`, no third-party rules engine (D11).

## Operators

| Op | Shape | Meaning |
|---|---|---|
| `and` / `or` | `{ op, of: ConditionAst[] }` | Short-circuit boolean |
| `not` | `{ op, of: ConditionAst }` | Negation |
| `eq` `neq` `lt` `lte` `gt` `gte` | `{ op, field, value }` | Compare field to a JSON primitive |
| `in` / `not_in` | `{ op, field, values }` | Membership |
| `has_label` / `lacks_label` | `{ op, value }` | Exact label key, or `risk:*` prefix match |
| `exists` / `missing` | `{ op, field }` | Presence |
| `count_gte` | `{ op, field, value }` | Numeric threshold on a countable field |

Max nesting depth: **8**. New fields require a PR and a unit test — the field enum is closed.

## Fields and null semantics

Every field is nullable. Rules:

1. **`missing`** is true when the value is `null`, `undefined`, or `""`.
2. **`exists`** is the complement (for booleans like `spec.exists`, true means the flag is true).
3. **Comparisons** (`eq`/`lt`/…) against a null/missing left-hand side are **false**, including `eq(field, null)`. Use `missing` / `exists` to test absence — never compare with a null literal.
4. **`count_*`** fields are never null: an absent collection reads as **0**. Therefore `exists` on a count field is always true and `missing` is always false; prefer `count_gte` / `eq` against `0`.
5. **`in`** on a missing field is false; **`not_in`** on a missing field is true.
6. **`has_label('risk:*')`** matches labels that start with `risk:` (e.g. `risk:high`). It does **not** match the bare key `risk`.

| Field | Type when present | Null / absent behaviour |
|---|---|---|
| `ticket.complexity` | `'low'\|'medium'\|'high'` | null until set |
| `ticket.stage.key` | string | null if stage missing |
| `ticket.owner_class` | `'ai'\|'human'\|'external'` | null rare |
| `ticket.title` | string | empty string possible |
| `spec.exists` | boolean | `false` when no spec version |
| `spec.acceptance_criteria.count` | number | `0` when no spec / empty array |
| `report.outcome` | string | null when no report |
| `report.confidence` | number | null when absent |
| `report.not_verified.count` | number | `0` when no report |
| `report.assumptions.count` | number | `0` when no report |
| `run.status` | string | null when no active run |
| `run.count_in_stage` | number | `0` |
| `warnings.open.count` | number | `0` |
| `warnings.open_in_current_stage.count` | number | `0` |
| `loop.count` / `loop.count_from_stage` | number | `0` until Phase 5 |
| `budget.item.spent_ratio` / `budget.project.spent_ratio` | number | null until Phase 4 |

> **Code changed to match this doc (2026-07-27 rework):** `eq(field, null)` on a missing field now returns false (was true); `has_label('risk:*')` no longer matches bare `risk`. Count-field `exists`/`missing` behaviour is documented here as-is (rule 4).


## Rendering

`describeCondition(ast)` produces human text for the UI and gate reasons, e.g. `complexity is set AND has no label risk:high`.

## Context

`buildGateContext(ctx, workItemId)` loads ticket, labels, spec, latest report, active run, open warnings, and project enforcement mode once per evaluation batch. The snapshot is immutable and stored on every `gate_evaluations` row.

## Warning lifecycle (field_rule)

1. A warn outcome persists a row with `code = config.code ?? slug(gate.name)`.
2. De-dupe: while an **open** or **dismissed** row exists for `(work_item, gate, code)`, re-evaluation does not create another.
3. A later **pass** of that gate resolves both open and dismissed rows for that code.
4. After a pass clears the row, a subsequent failure raises a **fresh** open warning.

Dismissal therefore suppresses noise until the underlying condition clears (gate passes), not forever.
