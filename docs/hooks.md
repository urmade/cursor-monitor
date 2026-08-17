# Hook installation and ingestion

## Supported platforms

The authenticated `/install` page generates one project-hook installer per OS:

| Platform | Runtime | Network client | Optional enrichment |
|---|---|---|---|
| Linux | `/bin/sh` | `curl` | `git` |
| macOS | built-in `/bin/sh` | built-in `curl` | `git` |
| Windows | Windows PowerShell 5.1+ or PowerShell 7 | built-in .NET `Invoke-WebRequest` | `git` |

The installers do not invoke a package manager and do not require Python, Node,
`jq`, or a third-party PowerShell module. Git is optional: without it, Cursor
payload repository/branch values are still sent when available.

Generic Linux does not define an HTTPS client in POSIX itself, so the Linux hook
uses the distribution's standard `curl` executable. No package is installed by
the script.

## Installed files

POSIX:

```text
.cursor/hooks.json
.cursor/hooks/cursor-monitor-start.sh
.cursor/hooks/cursor-monitor-stop.sh
```

Windows:

```text
.cursor/hooks.json
.cursor/hooks/cursor-monitor-start.ps1
.cursor/hooks/cursor-monitor-stop.ps1
```

Commit these files in each monitored repository. Project hooks work for local
IDEs and Cloud Agents that check out that repository. Team administrators can
also upload the same scripts and commands through managed Team Hooks.

## Hook behavior

`beforeSubmitPrompt` records an ISO timestamp under
`~/.cursor/cursor-monitor/started-at`. Cursor does not currently include a
conversation ID in that hook, so the file represents the most recent request
for the install.

`stop`:

1. reads the Cursor JSON payload from stdin;
2. chooses the payload workspace, `CURSOR_PROJECT_DIR`, or current directory;
3. optionally reads the origin remote and current branch with Git;
4. adds repository, branch, start, finish, and workspace fields;
5. POSTs to `/api/hooks/events` with a 12-second upper bound;
6. logs success/failure to `~/.cursor/cursor-monitor/hook.log`;
7. always exits zero so telemetry cannot block Cursor.

## Authentication

The generated hook sends:

- `x-vercel-protection-bypass: VERCEL_PROTECTION_BYPASS`
- `x-cursor-monitor-token: CURSOR_MONITOR_HOOK_TOKEN`

If the dedicated hook token is missing, the app uses the Vercel bypass as the
application token. Rotate to a dedicated token when practical.

Installer downloads use `Cache-Control: private, no-store` and require the
Passport-protected application. Treat generated scripts as secrets because the
credential is embedded for portability.

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
3. Confirm the installer was downloaded from the intended production/preview
   environment; its endpoint is fixed at generation time.
4. Download a fresh installer after token rotation.
5. Use the Operations page to confirm hook auth configuration.
