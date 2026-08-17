export type HookPlatform = 'linux' | 'macos' | 'windows';

export type InstallerArtifact = {
  platform: HookPlatform;
  filename: string;
  contentType: string;
  content: string;
  ready: boolean;
  requirements: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function publicBaseUrl(): string {
  const explicit = process.env.DEPLOYMENT_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (process.env.VERCEL_ENV === 'production' && production) {
    return `https://${production.replace(/\/$/, '')}`;
  }
  const branch = process.env.VERCEL_BRANCH_URL?.trim();
  if (branch) return `https://${branch.replace(/\/$/, '')}`;
  const deployment = process.env.VERCEL_URL?.trim();
  return deployment
    ? `https://${deployment.replace(/\/$/, '')}`
    : 'http://localhost:3000';
}

function values() {
  const token = process.env.CURSOR_MONITOR_HOOK_TOKEN?.trim() || '';
  return {
    endpoint: `${publicBaseUrl()}/api/hooks/events`,
    token,
    bypass: process.env.VERCEL_PROTECTION_BYPASS?.trim() ?? '',
  };
}

function posixInstaller(platform: 'linux' | 'macos'): InstallerArtifact {
  const { endpoint, token, bypass } = values();
  const startScript = [
    '#!/bin/sh',
    'set +e',
    'STATE_DIR="${HOME:-${TMPDIR:-/tmp}}/.cursor/cursor-monitor"',
    'mkdir -p "$STATE_DIR" 2>/dev/null',
    'RAW=$(cat 2>/dev/null)',
    `STATE_KEY=$(printf '%s' "$RAW" | tr '\\n' ' ' | sed -n 's/.*"conversation_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    `if [ -z "$STATE_KEY" ]; then STATE_KEY=$(printf '%s' "$RAW" | tr '\\n' ' ' | sed -n 's/.*"generation_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1); fi`,
    `STATE_KEY=$(printf '%s' "$STATE_KEY" | tr -cd 'A-Za-z0-9._-' | cut -c1-120)`,
    'START_FILE="$STATE_DIR/started-at${STATE_KEY:+-$STATE_KEY}"',
    'date -u +%Y-%m-%dT%H:%M:%SZ >"$START_FILE" 2>/dev/null',
    "printf '%s\\n' '{\"continue\":true}'",
    'exit 0',
  ].join('\n');
  const stopScript = [
    '#!/bin/sh',
    'set +e',
    `ENDPOINT_DEFAULT=${shellQuote(endpoint)}`,
    `TOKEN_DEFAULT=${shellQuote(token)}`,
    `BYPASS_DEFAULT=${shellQuote(bypass)}`,
    'ENDPOINT="${CURSOR_MONITOR_ENDPOINT:-$ENDPOINT_DEFAULT}"',
    'TOKEN="${CURSOR_MONITOR_HOOK_TOKEN:-$TOKEN_DEFAULT}"',
    'BYPASS="${VERCEL_PROTECTION_BYPASS:-$BYPASS_DEFAULT}"',
    'STATE_DIR="${HOME:-${TMPDIR:-/tmp}}/.cursor/cursor-monitor"',
    'LOG_FILE="$STATE_DIR/hook.log"',
    'mkdir -p "$STATE_DIR" 2>/dev/null',
    '',
    'json_escape() {',
    `  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/\t/\\\\t/g'`,
    '}',
    'json_string() {',
    '  _key="$1"',
    '  _input="$2"',
    `  printf '%s' "$_input" | tr '\\n' ' ' | sed -n "s/.*\\"$_key\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1`,
    '}',
    'normalize_repo() {',
    '  _remote="${1%.git}"',
    '  case "$_remote" in git@*) _remote="${_remote#git@}" ;; esac',
    '  case "$_remote" in',
    '    git+ssh://*) _remote="${_remote#git+ssh://}" ;;',
    '    ssh://*) _remote="${_remote#ssh://}" ;;',
    '    https://*) _remote="${_remote#https://}" ;;',
    '    http://*) _remote="${_remote#http://}" ;;',
    '  esac',
    '  case "$_remote" in *:*) _remote="${_remote#*:}" ;; esac',
    '  _first="${_remote%%/*}"',
    '  _rest="${_remote#*/}"',
    `  if [ "$_rest" != "$_remote" ] && printf '%s' "$_first" | grep -q '\\.'; then _remote="$_rest"; fi`,
    `  printf '%s' "$_remote"`,
    '}',
    '',
    'RAW=$(cat 2>/dev/null)',
    `if [ -z "$(printf '%s' "$RAW" | tr -d '[:space:]')" ]; then RAW='{}'; fi`,
    'STATE_KEY=$(json_string conversation_id "$RAW")',
    'if [ -z "$STATE_KEY" ]; then STATE_KEY=$(json_string generation_id "$RAW"); fi',
    `STATE_KEY=$(printf '%s' "$STATE_KEY" | tr -cd 'A-Za-z0-9._-' | cut -c1-120)`,
    'START_FILE="$STATE_DIR/started-at${STATE_KEY:+-$STATE_KEY}"',
    'if [ ! -f "$START_FILE" ] && [ -f "$STATE_DIR/started-at" ]; then START_FILE="$STATE_DIR/started-at"; fi',
    'WORKSPACE=$(json_string workspace_root "$RAW")',
    'if [ -z "$WORKSPACE" ]; then',
    `  WORKSPACE=$(printf '%s' "$RAW" | tr '\\n' ' ' | sed -n 's/.*"workspace_roots"[[:space:]]*:[[:space:]]*\\[[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    'fi',
    'ROOT="${WORKSPACE:-${CURSOR_PROJECT_DIR:-$PWD}}"',
    '[ -n "$WORKSPACE" ] || WORKSPACE="$ROOT"',
    'REPO=$(json_string repo "$RAW")',
    'BRANCH=$(json_string git_branch "$RAW")',
    'if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
    '  [ -n "$REPO" ] || REPO=$(normalize_repo "$(git -C "$ROOT" remote get-url origin 2>/dev/null)")',
    '  [ -n "$BRANCH" ] || BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)',
    'fi',
    'STARTED_AT=$(tr -d "\\r\\n" <"$START_FILE" 2>/dev/null)',
    'rm -f "$START_FILE" 2>/dev/null',
    'FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)',
    `CORE=$(printf '%s' "$RAW" | sed 's/}[[:space:]]*$//')`,
    'EXTRA=""',
    'if [ -n "$REPO" ]; then EXTRA="$EXTRA,\\"repo\\":\\"$(json_escape "$REPO")\\""; fi',
    'if [ -n "$BRANCH" ]; then EXTRA="$EXTRA,\\"git_branch\\":\\"$(json_escape "$BRANCH")\\""; fi',
    'if [ -n "$WORKSPACE" ]; then EXTRA="$EXTRA,\\"workspace_root\\":\\"$(json_escape "$WORKSPACE")\\""; fi',
    'if [ -n "$STARTED_AT" ]; then EXTRA="$EXTRA,\\"started_at\\":\\"$(json_escape "$STARTED_AT")\\""; fi',
    'if [ -n "$FINISHED_AT" ]; then EXTRA="$EXTRA,\\"finished_at\\":\\"$(json_escape "$FINISHED_AT")\\""; fi',
    'if [ "$CORE" = "{" ] || [ -z "$CORE" ]; then BODY="{${EXTRA#,}}"; else BODY="${CORE}${EXTRA}}"; fi',
    '',
    'STATUS=$(curl -sS --connect-timeout 5 --max-time 12 -X POST "$ENDPOINT" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept: application/json" \\',
    '  -H "User-Agent: cursor-monitor-hook/1.0" \\',
    '  -H "x-cursor-monitor-token: $TOKEN" \\',
    '  -H "x-vercel-protection-bypass: $BYPASS" \\',
    '  --data-binary "$BODY" -o "${TMPDIR:-/tmp}/cursor-monitor-response-$$" -w \'%{http_code}\' 2>/dev/null)',
    'if [ "$STATUS" = "200" ]; then',
    '  printf \'%s ok\\n\' "$FINISHED_AT" >>"$LOG_FILE"',
    'else',
    '  printf \'%s failed status=%s\\n\' "$FINISHED_AT" "${STATUS:-000}" >>"$LOG_FILE"',
    'fi',
    'rm -f "${TMPDIR:-/tmp}/cursor-monitor-response-$$" 2>/dev/null',
    "printf '%s\\n' '{}'",
    'exit 0',
  ].join('\n');
  const hooksJson = JSON.stringify(
    {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          {
            command: '.cursor/hooks/cursor-monitor-start.sh',
            timeout: 5,
          },
        ],
        stop: [
          {
            command: '.cursor/hooks/cursor-monitor-stop.sh',
            timeout: 15,
          },
        ],
      },
    },
    null,
    2,
  );
  const content = [
    '#!/bin/sh',
    `# Cursor Monitor project-hook installer for ${platform}.`,
    '# Uses only standard OS command-line tools; no package installation.',
    'set -eu',
    'for command_name in curl sed tr head cut date; do',
    '  command -v "$command_name" >/dev/null 2>&1 || { printf \'Missing required OS command: %s\\n\' "$command_name" >&2; exit 1; }',
    'done',
    'ROOT="${1:-$PWD}"',
    'HOOK_DIR="$ROOT/.cursor/hooks"',
    'mkdir -p "$HOOK_DIR"',
    `cat >"$HOOK_DIR/cursor-monitor-start.sh" <<'CURSOR_MONITOR_START'`,
    startScript,
    'CURSOR_MONITOR_START',
    `cat >"$HOOK_DIR/cursor-monitor-stop.sh" <<'CURSOR_MONITOR_STOP'`,
    stopScript,
    'CURSOR_MONITOR_STOP',
    'chmod +x "$HOOK_DIR/cursor-monitor-start.sh" "$HOOK_DIR/cursor-monitor-stop.sh"',
    'HOOKS_TARGET="$ROOT/.cursor/hooks.json"',
    'if [ -e "$HOOKS_TARGET" ]; then',
    '  HOOKS_TARGET="$ROOT/.cursor/hooks.cursor-monitor.example.json"',
    'fi',
    `cat >"$HOOKS_TARGET" <<'CURSOR_MONITOR_HOOKS'`,
    hooksJson,
    'CURSOR_MONITOR_HOOKS',
    'if [ "$HOOKS_TARGET" = "$ROOT/.cursor/hooks.json" ]; then',
    `  printf 'Cursor Monitor hooks installed in %s\\n' "$ROOT/.cursor"`,
    'else',
    `  printf 'Existing hooks.json kept. Merge %s into it before use.\\n' "$HOOKS_TARGET"`,
    'fi',
  ].join('\n');

  return {
    platform,
    filename: `install-cursor-monitor-${platform}.sh`,
    contentType: 'text/x-shellscript; charset=utf-8',
    content,
    ready: Boolean(token),
    requirements:
      platform === 'macos'
        ? 'Built-in macOS sh, curl, sed, and core command-line tools; git is optional.'
        : 'Standard distribution sh, curl, sed, and core command-line tools; git is optional.',
  };
}

function windowsInstaller(): InstallerArtifact {
  const { endpoint, token, bypass } = values();
  const startScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$stateDir = Join-Path $HOME '.cursor\\cursor-monitor'",
    'New-Item -ItemType Directory -Force -Path $stateDir | Out-Null',
    '$raw = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)',
    'try { $payload = $raw | ConvertFrom-Json } catch { $payload = [PSCustomObject]@{} }',
    '$stateKey = [string]$payload.conversation_id',
    'if ([string]::IsNullOrWhiteSpace($stateKey)) { $stateKey = [string]$payload.generation_id }',
    "$stateKey = $stateKey -replace '[^A-Za-z0-9._-]',''",
    'if ($stateKey.Length -gt 120) { $stateKey = $stateKey.Substring(0, 120) }',
    '$suffix = if ($stateKey) { "-$stateKey" } else { "" }',
    '$startFile = Join-Path $stateDir "started-at$suffix"',
    "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "[IO.File]::WriteAllText($startFile, (Get-Date).ToUniversalTime().ToString('o'), $utf8NoBom)",
    "Write-Output '{\"continue\":true}'",
    'exit 0',
  ].join('\r\n');
  const stopScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$endpointDefault = ${powershellQuote(endpoint)}`,
    `$tokenDefault = ${powershellQuote(token)}`,
    `$bypassDefault = ${powershellQuote(bypass)}`,
    '$endpoint = if ($env:CURSOR_MONITOR_ENDPOINT) { $env:CURSOR_MONITOR_ENDPOINT } else { $endpointDefault }',
    '$token = if ($env:CURSOR_MONITOR_HOOK_TOKEN) { $env:CURSOR_MONITOR_HOOK_TOKEN } else { $tokenDefault }',
    '$bypass = if ($env:VERCEL_PROTECTION_BYPASS) { $env:VERCEL_PROTECTION_BYPASS } else { $bypassDefault }',
    "$stateDir = Join-Path $HOME '.cursor\\cursor-monitor'",
    'New-Item -ItemType Directory -Force -Path $stateDir | Out-Null',
    "$logFile = Join-Path $stateDir 'hook.log'",
    '$raw = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)',
    "if ([string]::IsNullOrWhiteSpace($raw)) { $raw = '{}' }",
    'try { $payload = $raw | ConvertFrom-Json } catch { $payload = [PSCustomObject]@{} }',
    '$stateKey = [string]$payload.conversation_id',
    'if ([string]::IsNullOrWhiteSpace($stateKey)) { $stateKey = [string]$payload.generation_id }',
    "$stateKey = $stateKey -replace '[^A-Za-z0-9._-]',''",
    'if ($stateKey.Length -gt 120) { $stateKey = $stateKey.Substring(0, 120) }',
    '$suffix = if ($stateKey) { "-$stateKey" } else { "" }',
    "$workspace = [string]$payload.workspace_root",
    'if ([string]::IsNullOrWhiteSpace($workspace) -and $payload.workspace_roots) { $workspace = [string]$payload.workspace_roots[0] }',
    'if ([string]::IsNullOrWhiteSpace($workspace)) { $workspace = $env:CURSOR_PROJECT_DIR }',
    'if ([string]::IsNullOrWhiteSpace($workspace)) { $workspace = (Get-Location).Path }',
    '$repo = [string]$payload.repo',
    '$branch = [string]$payload.git_branch',
    "if (Get-Command git -ErrorAction SilentlyContinue) {",
    "  if ([string]::IsNullOrWhiteSpace($repo)) {",
    "    $remote = (& git -C $workspace remote get-url origin 2>$null)",
    "    if ($remote) {",
    "      $repo = $remote -replace '\\.git$','' -replace '^git@[^:]+:','' -replace '^https?://[^/]+/','' -replace '^ssh://[^/]+/',''",
    '    }',
    '  }',
    "  if ([string]::IsNullOrWhiteSpace($branch)) { $branch = (& git -C $workspace rev-parse --abbrev-ref HEAD 2>$null) }",
    '}',
    '$startedFile = Join-Path $stateDir "started-at$suffix"',
    "if (!(Test-Path $startedFile) -and (Test-Path (Join-Path $stateDir 'started-at'))) { $startedFile = Join-Path $stateDir 'started-at' }",
    '$started = if (Test-Path $startedFile) { (Get-Content $startedFile -Raw).Trim() } else { $null }',
    'Remove-Item $startedFile -Force -ErrorAction SilentlyContinue',
    "$finished = (Get-Date).ToUniversalTime().ToString('o')",
    "if ($repo) { $payload | Add-Member -NotePropertyName repo -NotePropertyValue $repo -Force }",
    "if ($branch) { $payload | Add-Member -NotePropertyName git_branch -NotePropertyValue $branch -Force }",
    "if ($workspace) { $payload | Add-Member -NotePropertyName workspace_root -NotePropertyValue $workspace -Force }",
    "if ($started) { $payload | Add-Member -NotePropertyName started_at -NotePropertyValue $started -Force }",
    "$payload | Add-Member -NotePropertyName finished_at -NotePropertyValue $finished -Force",
    "$body = $payload | ConvertTo-Json -Depth 32 -Compress",
    "$headers = @{ 'x-cursor-monitor-token' = $token; 'x-vercel-protection-bypass' = $bypass; 'User-Agent' = 'cursor-monitor-hook/1.0' }",
    'try {',
    "  Invoke-WebRequest -UseBasicParsing -Uri $endpoint -Method Post -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 12 | Out-Null",
    "  Add-Content -Path $logFile -Value \"$finished ok\"",
    '} catch {',
    "  Add-Content -Path $logFile -Value \"$finished failed $($_.Exception.Message)\"",
    '}',
    "Write-Output '{}'",
    'exit 0',
  ].join('\r\n');
  const hooksJson = JSON.stringify(
    {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          {
            command:
              'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/cursor-monitor-start.ps1',
            timeout: 5,
          },
        ],
        stop: [
          {
            command:
              'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/cursor-monitor-stop.ps1',
            timeout: 15,
          },
        ],
      },
    },
    null,
    2,
  );
  const content = [
    "$ErrorActionPreference = 'Stop'",
    '$root = if ($args[0]) { Resolve-Path $args[0] } else { Get-Location }',
    "$hookDir = Join-Path $root '.cursor\\hooks'",
    'New-Item -ItemType Directory -Force -Path $hookDir | Out-Null',
    `$hooksJson = @'\r\n${hooksJson}\r\n'@`,
    `$startScript = @'\r\n${startScript}\r\n'@`,
    `$stopScript = @'\r\n${stopScript}\r\n'@`,
    '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
    "[IO.File]::WriteAllText((Join-Path $hookDir 'cursor-monitor-start.ps1'), $startScript, $utf8NoBom)",
    "[IO.File]::WriteAllText((Join-Path $hookDir 'cursor-monitor-stop.ps1'), $stopScript, $utf8NoBom)",
    "$hooksTarget = Join-Path $root '.cursor\\hooks.json'",
    'if (Test-Path $hooksTarget) {',
    "  $hooksTarget = Join-Path $root '.cursor\\hooks.cursor-monitor.example.json'",
    '}',
    '[IO.File]::WriteAllText($hooksTarget, $hooksJson, $utf8NoBom)',
    "if ($hooksTarget.EndsWith('hooks.json')) {",
    '  Write-Host "Cursor Monitor hooks installed in $root\\.cursor"',
    '} else {',
    '  Write-Host "Existing hooks.json kept. Merge $hooksTarget into it before use."',
    '}',
  ].join('\r\n');

  return {
    platform: 'windows',
    filename: 'install-cursor-monitor-windows.ps1',
    contentType: 'text/plain; charset=utf-8',
    content,
    ready: Boolean(token),
    requirements:
      'Windows PowerShell 5.1 or PowerShell 7 and built-in .NET networking; git is optional.',
  };
}

export function buildInstaller(platform: string): InstallerArtifact | null {
  if (platform === 'linux') return posixInstaller('linux');
  if (platform === 'macos') return posixInstaller('macos');
  if (platform === 'windows') return windowsInstaller();
  return null;
}
