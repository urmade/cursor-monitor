# Nexus MCP contract — `nexus-mcp/1`

Frozen in Phase 2. Additive changes (new optional field, new tool) do **not** bump the version. Breaking changes require a new version running in parallel for at least one phase, plus an ADR.

Every tool response is an envelope:

```json
{ "ok": true, "contract": "nexus-mcp/1", "data": { ... } }
```

or

```json
{
  "ok": false,
  "contract": "nexus-mcp/1",
  "error": { "code": "validation", "message": "...", "retryable": false, "hint": "..." }
}
```

Errors are returned as tool results (not transport errors) so agents can read and act.

**Auth.** `Authorization: Bearer <run-token>`. The token defines the ticket — every tool takes `ticket_id` and the server rejects mismatches (`ticket_mismatch` / `forbidden`). Tokens are SHA-256 hashed at rest, TTL 90 minutes, revoked at run terminal. Rate limit: 120 calls/minute per token (`rate_limited`, retryable).

**Transport.** Stateless streamable HTTP at `/api/mcp`. Inject per run with `mcpServers: [{ name: "nexus", type: "http", url, headers: { Authorization, x-vercel-protection-bypass } }]`.

## Tools

| Tool | R/W | Limits |
|---|---|---|
| `get_ticket` | R | — |
| `get_spec` | R | Spec ≤ 100 KB |
| `update_spec` | W | Spec ≤ 100 KB; `mode: merge\|replace`; optional `base_version` |
| `post_stage_report` | W | Once per run; summary ≤ 20 KB; ≤ 20 labels; ≤ 20 artifacts |
| `set_labels` | W | ≤ 20 labels/call; taxonomy + `agent_settable` |
| `ask_question` | W | Text ≤ 4 KB; `blocking` marks `needs_answer` |
| `attach_artifact_ref` | W | ≤ 20 refs/run |
| `get_gate_context` | R | Recent results, warnings, pending approvals |
| `list_questions` | R | Most recent 50 + total count |

### `get_ticket`

```json
{ "ticket_id": "<uuid>" }
```

Returns: `id`, `key`, `title`, `description`, `complexity`, `stage`, `labels`, `owner_class`, `status`, `spec` meta, `warnings` (open warnings with `id`/`code`/`message`/`status`/`created_at` — populated in Phase 3), `budget` (null until P4), `links.ui_url`.

### `get_spec`

```json
{ "ticket_id": "<uuid>", "version": 2 }
```

`version` optional — defaults to current.

### `update_spec`

```json
{
  "ticket_id": "<uuid>",
  "content": { "summary": "...", "context": "...", "approach": "..." },
  "mode": "merge",
  "base_version": 1,
  "note": "optional"
}
```

Creates a new append-only version authored by the agent.

### `post_stage_report`

See `StageReport` in `packages/contracts/src/mcp/stage-report.ts`. Key fields: `outcome` (`complete|partial|blocked|failed`), `headline`, `summary`, `assumptions`, `not_verified`, `questions`, `labels_to_set`, `acceptance_criteria`, `artifact_refs`.

Idempotent: a second call returns the first report with `already_posted: true`. Invalid labels reject the **whole** call.

### `set_labels`

```json
{ "ticket_id": "<uuid>", "add": ["risk:high"], "remove": [] }
```

### `ask_question`

```json
{ "ticket_id": "<uuid>", "text": "...", "blocking": true, "options": ["A", "B"] }
```

### `attach_artifact_ref`

```json
{ "ticket_id": "<uuid>", "kind": "pr", "url": "https://...", "title": "optional" }
```

`kind`: `pr|branch|preview|artifact|link`.

### `get_gate_context`

```json
{ "ticket_id": "<uuid>" }
```

Returns (Phase 3 — additive, still `nexus-mcp/1`):

- `gates[]` — latest evaluation per gate: `gate_id`, `gate_name`, `gate_version`, `outcome`, `reason`, `evidence`, `evaluated_at`
- `recent_evaluations[]` — last 10 evaluations
- `warnings[]` — open warnings with codes/messages
- `pending_approvals[]` — pending approval requests and `requested_for` trigger

**Fingerprint note (2026-07-27).** Tool *argument* schemas are unchanged; only response payloads gained fields. Golden fingerprint in `contract.golden.test.ts` is therefore unchanged. If a future change alters arg schemas, update `EXPECTED_FINGERPRINT` deliberately and document here.

### `list_questions`

Read helper for open/answered questions (most recent 50 + total).

## Error codes

`unauthorized`, `forbidden`, `ticket_mismatch`, `not_found`, `validation`, `conflict`, `already_posted`, `rate_limited`, `payload_too_large`, `label_unknown`, `label_not_agent_settable`, `stale_version`, `internal`.

## Versioning policy

1. Additive optional fields / new tools → stay on `nexus-mcp/1`, update this doc and golden fingerprint with a note.
2. Removing/renaming fields, changing meaning, or tightening requiredness → new version (`nexus-mcp/2`) + ADR.
3. Golden-file test in `packages/contracts/src/mcp/contract.golden.test.ts` fails on unintentional schema drift.
