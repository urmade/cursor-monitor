# Team Hook scripts and ingestion

## Intended deployment

Cursor Monitor generates direct scripts for centrally managed Cursor Team Hooks.
It does not generate installers, write `.cursor/hooks.json`, modify repositories,
or install files on developer machines.

The authenticated `/hooks` page provides two downloads for each operating
system:

1. `beforeSubmitPrompt` records the request start time.
2. `stop` enriches the completed request and POSTs it to Cursor Monitor.

Upload both scripts directly in Cursor's Team Hooks settings and apply them to
the intended team scope.

## Supported platforms

| Platform | Runtime | Network client | Optional enrichment |
|---|---|---|---|
| Linux | `/bin/sh` + standard text/core utilities | `curl` | `git` |
| macOS | built-in `/bin/sh` + standard utilities | built-in `curl` | `git` |
| Windows | Windows PowerShell 5.1+ or PowerShell 7 | built-in .NET `Invoke-WebRequest` | `git` |

The scripts do not invoke a package manager and do not require Python, Node,
`jq`, or a third-party PowerShell module. Git is optional: without it, Cursor
payload repository/branch values are still sent when available.

Direct download endpoints:

```text
/api/hooks/linux/start
/api/hooks/linux/stop
/api/hooks/macos/start
/api/hooks/macos/stop
/api/hooks/windows/start
/api/hooks/windows/stop
```

Downloads require an authenticated administrator, use
`Cache-Control: private, no-store`, and return `503` until
`CURSOR_MONITOR_HOOK_TOKEN` is configured.

## Hook behavior

`beforeSubmitPrompt` records an ISO timestamp under
`~/.cursor/cursor-monitor/started-at-<conversation-or-generation>`. When Cursor
does not provide either identifier, it falls back to `started-at`. The stop hook
uses the same key and can consume the fallback for compatibility.

`stop`:

1. reads the Cursor JSON payload from stdin;
2. chooses the payload workspace, `CURSOR_PROJECT_DIR`, or current directory;
3. optionally reads the origin remote and current branch with Git;
4. adds repository, branch, start, finish, and workspace fields;
5. POSTs to `/api/hooks/events` with a 12-second upper bound;
6. logs success/failure to `~/.cursor/cursor-monitor/hook.log`;
7. always exits zero so telemetry cannot block Cursor.

Recommended Team Hook timeouts are five seconds for `beforeSubmitPrompt` and
fifteen seconds for `stop`.

## Authentication

### Hook token

Team Hooks run on developer machines and POST completed requests to a public HTTP
endpoint. They cannot present a Passport browser session, so Cursor Monitor uses a
dedicated server-side secret instead.

`CURSOR_MONITOR_HOOK_TOKEN` authorizes only `POST /api/hooks/events`. It does not
grant access to the dashboard, settings, hook-script downloads, or any other route.
Human administrators still sign in through Passport independently.

Generate a long random value and store it in your deployment secret manager. The
stop hook sends it as `x-cursor-monitor-token` (or `Authorization: Bearer …`).
Fresh script downloads embed the current token and endpoint; re-download after
rotation unless centrally managed Team Hook environment variables override
`CURSOR_MONITOR_HOOK_TOKEN` or `CURSOR_MONITOR_ENDPOINT`.

Possession of the hook token permits event submission but not data export or
configuration changes. Treat downloaded stop scripts as secrets because they
embed the token for portability.

The generated stop hook sends:

- `x-cursor-monitor-token: CURSOR_MONITOR_HOOK_TOKEN`

At runtime, `CURSOR_MONITOR_ENDPOINT` and `CURSOR_MONITOR_HOOK_TOKEN` override
embedded values. Centrally managed Team Hooks should prefer these environment
values when available to simplify rotation.

Fresh script downloads are generated from the running app configuration.
`CURSOR_MONITOR_PUBLIC_URL` is the preferred explicit public base URL;
`DEPLOYMENT_URL` and Vercel deployment URL variables remain supported
fallbacks.

Database adapter IDs and credentials are never embedded in hooks. Replacing
`DATABASE_ADAPTER`, `DATABASE_URL`, or a provider alias changes only the
server-side persistence target and does not require a hook update.

Treat downloaded stop scripts as secrets because they embed the ingestion
credential for portability. Do not commit them to repositories.

## Payload contract

The endpoint accepts any JSON object up to 256 KiB. Known fields:

```json
{
  "hook_event_name": "stop",
  "conversation_id": "string",
  "generation_id": "string",
  "repo": "owner/repository",
  "git_branch": "branch",
  "workspace_root": "/path",
  "user_email": "person@example.com",
  "model": "model",
  "status": "completed",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601"
}
```

Unknown fields are retained in `payload`. Invalid or missing optional fields do
not reject the event.

Responses:

- `200`: stored or recognized as a duplicate
- `400`: malformed JSON
- `401`: missing/incorrect app token
- `413`: body over 256 KiB

## Troubleshooting

1. Read `~/.cursor/cursor-monitor/hook.log`.
2. Check `/api/health`.
3. Confirm scripts were downloaded from the intended production/preview
   environment; the endpoint is fixed at generation time.
4. Download and re-upload the stop script after token or public URL rotation,
   unless Team Hook environment overrides supply those values.
5. Use the Operations page to confirm hook auth configuration.
