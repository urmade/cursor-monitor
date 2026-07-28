# Authoring Cursor Automations for Nexus

This guide is enough to wire a new automation to a Nexus stage without reading the codebase.

## What an automation must do

1. Receive only a **ticket id** (and optionally a run nonce) — never a full payload dump.
2. Call Nexus MCP tools for all context and all output.
3. Call `post_stage_report` **exactly once** before finishing. A run that finishes without a report becomes `completed_no_report` (treated as needing attention, not success).

## MCP setup

Nexus injects the MCP server per run:

- URL: `https://<your-nexus-host>/api/mcp`
- Headers: `Authorization: Bearer <run-token>` and `x-vercel-protection-bypass: <secret>` (when the preview is Passport-protected)

You do not configure MCP in the repo for the Cloud Agents path. For webhook automations, include the MCP URL from the webhook payload.

Contract version: **`nexus-mcp/1`** — see `docs/mcp-contract.md`.

## Recommended flow (scoping)

```
1. get_ticket({ ticket_id })
2. get_spec({ ticket_id })          # may be empty
3. Do the stage work (draft a spec, classify, etc.)
4. update_spec({ ticket_id, content, mode: "merge" })
5. set_labels({ ticket_id, add: ["…"] })   # only agent_settable keys
6. If blocked on a human decision:
     ask_question({ ticket_id, text, blocking: true })
     stop (do not post a "complete" report — use outcome "blocked")
7. post_stage_report({ ticket_id, stage, outcome, headline, summary, … })
```

## Copy-paste prompt skeleton

```
You are working on ticket {{ticket.key}} ({{ticket.id}}) at stage "{{stage.name}}".

Use the `nexus` MCP server for all context and all output:
  1. Call get_ticket and get_spec first. Do not assume anything not returned there.
  2. Do the stage's work as defined by your automation's own instructions and the repository's rules.
  3. If you are blocked on a human decision, call ask_question with blocking: true and stop.
  4. Before finishing, call post_stage_report exactly once. A run without a report is treated as a failure.

Run correlation nonce: {{run.nonce}} (include it if a tool asks for it).
```

## Stage report contract (minimum)

| Field | Required | Notes |
|---|---|---|
| `ticket_id` | yes | Must match token scope |
| `stage` | yes | Echo stage key or name |
| `outcome` | yes | `complete` \| `partial` \| `blocked` \| `failed` |
| `headline` | yes | ≤ 200 chars — shown on the ticket at a glance |
| `summary` | no | Markdown, ≤ 20 KB |
| `assumptions` | no | ≤ 20 strings |
| `not_verified` | no | ≤ 20 strings |
| `questions` | no | Also creatable via `ask_question` |
| `labels_to_set` | no | Must exist + be agent-settable |
| `acceptance_criteria` | no | Stored even if project has the concept disabled |
| `artifact_refs` | no | URL refs only — no bytes |

Invalid labels reject the **entire** report. Fix the label key and retry (or omit it).

## Failure modes agents should know

| Situation | What Nexus records |
|---|---|
| Provider FINISHED, no `post_stage_report` | `completed_no_report` |
| Provider FAILED | `failed` |
| Deadline exceeded | `expired` (cancel is best-effort and may 500) |
| Second `post_stage_report` | Returns first report, `already_posted: true` |
| Wrong `ticket_id` | Tool error `ticket_mismatch` / `forbidden` |
| Unknown / non-agent-settable label | Whole report rejected |

## Binding in Nexus UI

Project Settings → Automation bindings:

1. Create a prompt template (or use `default`).
2. Add a `cloud_agent` binding for the stage (Scoping for the PoC).
3. Prefer **no-repo** for demos; set a repo URL when the stage needs code.
4. Use **Test resolve** to confirm which binding a labelled ticket selects.

## Deliberately failing automation (demo)

Use a prompt that calls `get_ticket` and then stops **without** `post_stage_report`. Nexus will show the run as `completed_no_report` or `failed` — never as a silent success.
