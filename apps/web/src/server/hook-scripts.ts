export type HookPlatform = 'linux' | 'macos' | 'windows';
export type HookScriptKind = 'start' | 'stop';
export type HookEventName = 'beforeSubmitPrompt' | 'stop';

export type HookScriptArtifact = {
  platform: HookPlatform;
  kind: HookScriptKind;
  eventName: HookEventName;
  filename: string;
  contentType: string;
  content: string;
  ready: boolean;
  timeout: number;
};

export type HookScriptBundle = {
  platform: HookPlatform;
  requirements: string;
  scripts: readonly [HookScriptArtifact, HookScriptArtifact];
  ready: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function publicBaseUrl(): string {
  const explicit = (
    process.env.CURSOR_MONITOR_PUBLIC_URL ??
    process.env.DEPLOYMENT_URL
  )?.trim();
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
  };
}

function posixHookScripts(
  platform: 'linux' | 'macos',
): HookScriptBundle {
  const { endpoint, token } = values();
  const ready = Boolean(token);
  const startScript = [
    '#!/bin/sh',
    `# Cursor Monitor ${platform} Team Hook: beforeSubmitPrompt`,
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
    `# Cursor Monitor ${platform} Team Hook: stop`,
    'set +e',
    `ENDPOINT_DEFAULT=${shellQuote(endpoint)}`,
    `TOKEN_DEFAULT=${shellQuote(token)}`,
    'ENDPOINT="${CURSOR_MONITOR_ENDPOINT:-$ENDPOINT_DEFAULT}"',
    'TOKEN="${CURSOR_MONITOR_HOOK_TOKEN:-$TOKEN_DEFAULT}"',
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

  return {
    platform,
    ready,
    requirements:
      platform === 'macos'
        ? 'Built-in macOS sh, curl, sed, and core command-line tools; git is optional.'
        : 'Standard distribution sh, curl, sed, and core command-line tools; git is optional.',
    scripts: [
      {
        platform,
        kind: 'start',
        eventName: 'beforeSubmitPrompt',
        filename: `cursor-monitor-${platform}-start.sh`,
        contentType: 'text/x-shellscript; charset=utf-8',
        content: startScript,
        ready,
        timeout: 5,
      },
      {
        platform,
        kind: 'stop',
        eventName: 'stop',
        filename: `cursor-monitor-${platform}-stop.sh`,
        contentType: 'text/x-shellscript; charset=utf-8',
        content: stopScript,
        ready,
        timeout: 15,
      },
    ],
  };
}

function windowsHookScripts(): HookScriptBundle {
  const { endpoint, token } = values();
  const ready = Boolean(token);
  const startScript = [
    '# Cursor Monitor Windows Team Hook: beforeSubmitPrompt',
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
    '# Cursor Monitor Windows Team Hook: stop',
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$endpointDefault = ${powershellQuote(endpoint)}`,
    `$tokenDefault = ${powershellQuote(token)}`,
    '$endpoint = if ($env:CURSOR_MONITOR_ENDPOINT) { $env:CURSOR_MONITOR_ENDPOINT } else { $endpointDefault }',
    '$token = if ($env:CURSOR_MONITOR_HOOK_TOKEN) { $env:CURSOR_MONITOR_HOOK_TOKEN } else { $tokenDefault }',
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
    "$headers = @{ 'x-cursor-monitor-token' = $token; 'User-Agent' = 'cursor-monitor-hook/1.0' }",
    'try {',
    "  Invoke-WebRequest -UseBasicParsing -Uri $endpoint -Method Post -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 12 | Out-Null",
    "  Add-Content -Path $logFile -Value \"$finished ok\"",
    '} catch {',
    "  Add-Content -Path $logFile -Value \"$finished failed $($_.Exception.Message)\"",
    '}',
    "Write-Output '{}'",
    'exit 0',
  ].join('\r\n');

  return {
    platform: 'windows',
    ready,
    requirements:
      'Windows PowerShell 5.1 or PowerShell 7 and built-in .NET networking; git is optional.',
    scripts: [
      {
        platform: 'windows',
        kind: 'start',
        eventName: 'beforeSubmitPrompt',
        filename: 'cursor-monitor-windows-start.ps1',
        contentType: 'text/plain; charset=utf-8',
        content: startScript,
        ready,
        timeout: 5,
      },
      {
        platform: 'windows',
        kind: 'stop',
        eventName: 'stop',
        filename: 'cursor-monitor-windows-stop.ps1',
        contentType: 'text/plain; charset=utf-8',
        content: stopScript,
        ready,
        timeout: 15,
      },
    ],
  };
}

export function buildHookScripts(platform: string): HookScriptBundle | null {
  if (platform === 'linux') return posixHookScripts('linux');
  if (platform === 'macos') return posixHookScripts('macos');
  if (platform === 'windows') return windowsHookScripts();
  return null;
}

export function getHookScript(
  platform: string,
  kind: string,
): HookScriptArtifact | null {
  if (kind !== 'start' && kind !== 'stop') return null;
  return (
    buildHookScripts(platform)?.scripts.find((script) => script.kind === kind) ??
    null
  );
}
