import { timingSafeEqual } from 'node:crypto';

/** Prefer the cloud-agent alias, then the synced Vercel secret. */
export function readProtectionBypass(): string | null {
  const value =
    process.env.NEXUS_VERCEL_BYPASS?.trim() ||
    process.env.VERCEL_PROTECTION_BYPASS?.trim() ||
    '';
  return value.length > 0 ? value : null;
}

/** Where {@link resolvePublicBaseUrlDetailed} took the base URL from. */
export type PublicBaseUrlSource =
  | 'deployment_url_env'
  | 'production_domain'
  | 'branch_domain'
  | 'request_host'
  | 'vercel_deployment'
  | 'localhost';

export type ResolvedPublicBaseUrl = {
  baseUrl: string;
  source: PublicBaseUrlSource;
  /** Vercel environment this URL belongs to, when the platform reports one. */
  environment: string | null;
  /**
   * False when the URL is tied to one immutable deployment: hooks installed
   * from it keep posting to that build and stop matching later deploys.
   */
  stable: boolean;
};

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * Resolve the base URL that external tooling (Cursor stop hooks) should post to.
 *
 * Deployment-scoped hosts (`VERCEL_URL`) are a last resort: they change on every
 * deploy, so a hook installed from one silently keeps writing to an old build —
 * and a preview host writes into the preview database, invisible in production.
 */
export function resolvePublicBaseUrlDetailed(req?: Request): ResolvedPublicBaseUrl {
  const environment = envValue('VERCEL_ENV');

  const override = envValue('DEPLOYMENT_URL');
  if (override) {
    return {
      baseUrl: withoutTrailingSlash(override),
      source: 'deployment_url_env',
      environment,
      stable: true,
    };
  }

  const productionDomain = envValue('VERCEL_PROJECT_PRODUCTION_URL');
  if (environment === 'production' && productionDomain) {
    return {
      baseUrl: `https://${withoutTrailingSlash(productionDomain)}`,
      source: 'production_domain',
      environment,
      stable: true,
    };
  }

  const branchDomain = envValue('VERCEL_BRANCH_URL');
  if (environment === 'preview' && branchDomain) {
    return {
      baseUrl: `https://${withoutTrailingSlash(branchDomain)}`,
      source: 'branch_domain',
      environment,
      stable: true,
    };
  }

  const deploymentHost = envValue('VERCEL_URL');
  if (req) {
    const host = (
      req.headers.get('x-forwarded-host') ??
      req.headers.get('host') ??
      ''
    ).trim();
    if (host && host !== deploymentHost) {
      const proto = req.headers.get('x-forwarded-proto') ?? 'https';
      return {
        baseUrl: withoutTrailingSlash(`${proto}://${host}`),
        source: 'request_host',
        environment,
        stable: true,
      };
    }
  }

  if (deploymentHost) {
    return {
      baseUrl: `https://${withoutTrailingSlash(deploymentHost)}`,
      source: 'vercel_deployment',
      environment,
      stable: false,
    };
  }

  return {
    baseUrl: 'http://localhost:3000',
    source: 'localhost',
    environment,
    stable: true,
  };
}

export function resolvePublicBaseUrl(req?: Request): string {
  return resolvePublicBaseUrlDetailed(req).baseUrl;
}

export function authorizeStopHookRequest(req: Request): boolean {
  const expected = readProtectionBypass();
  if (!expected) return false;

  const provided =
    req.headers.get('x-vercel-protection-bypass')?.trim() ||
    req.headers.get('x-nexus-protection-bypass')?.trim() ||
    '';
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Normalize git remotes / path-ish values into owner/repo when possible. */
export function normalizeRepoLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  value = value.replace(/\.git$/i, '');
  value = value.replace(/^git\+ssh:\/\//i, '');
  value = value.replace(/^ssh:\/\//i, '');
  value = value.replace(/^https?:\/\//i, '');
  value = value.replace(/^git@/i, '');

  // host:owner/repo
  const scp = value.match(/^[^/:]+:(.+)$/);
  if (scp) value = scp[1]!;

  // github.com/owner/repo → owner/repo
  const parts = value.split('/').filter(Boolean);
  if (parts.length >= 2) {
    // If first segment looks like a host, drop it
    if (parts[0]!.includes('.')) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return value || null;
}

export function extractRepoFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const candidates = [
    payload.repo,
    payload.repository,
    payload.git_repository,
    payload.git_repo,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return normalizeRepoLabel(c);
    }
  }
  return null;
}

export function extractBranchFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const candidates = [payload.git_branch, payload.branch, payload.gitBranch];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

export function extractWorkspaceRoot(
  payload: Record<string, unknown>,
): string | null {
  if (typeof payload.workspace_root === 'string' && payload.workspace_root.trim()) {
    return payload.workspace_root.trim();
  }
  if (Array.isArray(payload.workspace_roots)) {
    const first = payload.workspace_roots.find(
      (r): r is string => typeof r === 'string' && r.trim().length > 0,
    );
    return first?.trim() ?? null;
  }
  return null;
}

export type StopHookArtifact = {
  endpoint: string;
  bypassConfigured: boolean;
  /** Team Hooks dashboard / managed-dir command (cwd = managed hooks dir). */
  hooksJson: string;
  /**
   * Project hooks for Cloud Agents: committed at `.cursor/hooks.json`.
   * Cloud agent VMs do not receive the IDE team-hook managed directory sync.
   */
  projectHooksJson: string;
  scriptFilename: string;
  script: string;
  /** Local file the script appends every POST outcome to. */
  logFile: string;
  installSteps: string[];
};

/** Default local log path written by the generated script. */
export const STOP_HOOK_LOG_FILE = '~/.cursor/nexus-stop-hook.log';

/**
 * Build a ready-to-paste Cursor stop hook that POSTs stdin metadata to Nexus.
 * POSIX `/bin/sh` + curl (+ git for repo/branch enrichment) — no bashisms,
 * language runtimes, or jq. Runs natively on Linux and macOS.
 * Bypass is hardcoded so non-Vercel projects can clear deployment protection;
 * cloud agents may also supply `NEXUS_VERCEL_BYPASS` / `VERCEL_PROTECTION_BYPASS`.
 */
export function buildStopHookArtifact(opts: {
  baseUrl: string;
  bypass: string | null;
}): StopHookArtifact {
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/api/hooks/stop`;
  const bypass = opts.bypass ?? '';
  const bypassConfigured = bypass.length > 0;
  const scriptFilename = 'nexus-stop-to-supabase.sh';

  // Team hooks sync into ~/.cursor/managed/team_<id>/hooks/ on the local IDE.
  // Cloud agent VMs typically do NOT get that directory — use projectHooksJson.
  const hooksJson = JSON.stringify(
    {
      version: 1,
      hooks: {
        stop: [
          {
            command: `./${scriptFilename}`,
            timeout: 15,
          },
        ],
      },
    },
    null,
    2,
  );

  // Project hooks: relative to the repository root (Cloud Agents load these).
  const projectHooksJson = JSON.stringify(
    {
      version: 1,
      hooks: {
        stop: [
          {
            command: `.cursor/hooks/${scriptFilename}`,
            timeout: 15,
          },
        ],
      },
    },
    null,
    2,
  );

  const script = [
    '#!/bin/sh',
    '# Cursor stop hook — store turn metadata in Nexus (Supabase-backed Postgres).',
    '# Native Linux + macOS: POSIX sh + curl + git only. No bash/Python/Node/jq.',
    '#',
    '# Install:',
    '#   • Local IDE (Team Hooks): script name MUST be this filename under',
    '#     ~/.cursor/managed/team_<id>/hooks/ — not a title like "Cost".',
    '#   • Cloud Agents: commit .cursor/hooks.json + .cursor/hooks/<this file>',
    '#     (team managed hooks are not synced into cloud VMs).',
    '#',
    '# Workspace root: stdin / CURSOR_PROJECT_DIR (team cwd is the managed dir).',
    `# Filename: ${scriptFilename}`,
    '',
    'set +e',
    `ENDPOINT_DEFAULT=${shellDoubleQuote(endpoint)}`,
    'ENDPOINT="${NEXUS_STOP_HOOK_ENDPOINT:-}"',
    'if [ -z "$ENDPOINT" ]; then ENDPOINT="$ENDPOINT_DEFAULT"; fi',
    '# Prefer cloud-agent / environment secrets when present; else baked-in bypass.',
    'BYPASS="${NEXUS_VERCEL_BYPASS:-${VERCEL_PROTECTION_BYPASS:-}}"',
    `if [ -z "$BYPASS" ]; then BYPASS=${shellDoubleQuote(bypass)}; fi`,
    '',
    'json_escape() {',
    "  printf '%s' \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g' -e 's/	/\\\\t/g'",
    '}',
    '',
    'json_get_string() {',
    '  # Best-effort top-level "key":"value" extract (no jq).',
    '  _key="$1"',
    '  _src="$2"',
    '  printf \'%s\' "$_src" | tr \'\\n\' \' \' | sed -n "s/.*\\"$_key\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1',
    '}',
    '',
    'normalize_repo() {',
    '  _raw="$1"',
    '  _raw="${_raw%.git}"',
    '  case "$_raw" in',
    '    git@*) _raw="${_raw#git@}" ;;',
    '  esac',
    '  case "$_raw" in',
    '    ssh://*) _raw="${_raw#ssh://}" ;;',
    '    git+ssh://*) _raw="${_raw#git+ssh://}" ;;',
    '    http://*) _raw="${_raw#http://}" ;;',
    '    https://*) _raw="${_raw#https://}" ;;',
    '  esac',
    '  case "$_raw" in',
    '    *:*) _raw="${_raw#*:}" ;;',
    '  esac',
    '  # Drop host segment when present (github.com/owner/repo).',
    '  _first="${_raw%%/*}"',
    '  _rest="${_raw#*/}"',
    '  if [ "$_rest" != "$_raw" ] && printf \'%s\' "$_first" | grep -q \'\\.\'; then',
    '    _raw="$_rest"',
    '  fi',
    '  printf \'%s\' "$_raw"',
    '}',
    '',
    'detect_git() {',
    '  _root="$1"',
    '  REPO_OUT=""',
    '  BRANCH_OUT=""',
    '  [ -n "$_root" ] && [ -d "$_root" ] || return 0',
    '  command -v git >/dev/null 2>&1 || return 0',
    '  git -C "$_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0',
    '  BRANCH_OUT=$(git -C "$_root" rev-parse --abbrev-ref HEAD 2>/dev/null)',
    '  _remote=$(git -C "$_root" remote get-url origin 2>/dev/null)',
    '  if [ -n "$_remote" ]; then',
    '    REPO_OUT=$(normalize_repo "$_remote")',
    '  else',
    '    REPO_OUT=$(basename "$_root")',
    '  fi',
    '}',
    '',
    'RAW=$(cat 2>/dev/null)',
    'RAW_TRIM=$(printf \'%s\' "$RAW" | tr -d \'[:space:]\')',
    'if [ -z "$RAW_TRIM" ]; then',
    "  RAW='{}'",
    'fi',
    '',
    'REPO=$(json_get_string repo "$RAW")',
    'if [ -z "$REPO" ]; then REPO=$(json_get_string repository "$RAW"); fi',
    'if [ -z "$REPO" ]; then REPO=$(json_get_string git_repository "$RAW"); fi',
    'BRANCH=$(json_get_string git_branch "$RAW")',
    'if [ -z "$BRANCH" ]; then BRANCH=$(json_get_string branch "$RAW"); fi',
    'WORKSPACE_ROOT=$(json_get_string workspace_root "$RAW")',
    '',
    'if [ -z "$WORKSPACE_ROOT" ]; then',
    '  WORKSPACE_ROOT=$(printf \'%s\' "$RAW" | tr \'\\n\' \' \' | sed -n \'s/.*"workspace_roots"[[:space:]]*:[[:space:]]*\\[[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | head -n 1)',
    'fi',
    '# Team hooks / cloud agents: cwd may be the managed hooks dir, not the repo.',
    '# Prefer payload roots, then Cursor/Claude project env, then $PWD (project hooks).',
    'ROOT=""',
    'if [ -n "$WORKSPACE_ROOT" ] && [ -d "$WORKSPACE_ROOT" ]; then',
    '  ROOT="$WORKSPACE_ROOT"',
    'elif [ -n "${CURSOR_PROJECT_DIR:-}" ] && [ -d "$CURSOR_PROJECT_DIR" ]; then',
    '  ROOT="$CURSOR_PROJECT_DIR"',
    'elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR" ]; then',
    '  ROOT="$CLAUDE_PROJECT_DIR"',
    'else',
    '  ROOT="$PWD"',
    'fi',
    'if [ -z "$WORKSPACE_ROOT" ]; then WORKSPACE_ROOT="$ROOT"; fi',
    '',
    'REPO_OUT=""',
    'BRANCH_OUT=""',
    'detect_git "$ROOT"',
    'if [ -z "$REPO" ] && [ -n "$REPO_OUT" ]; then REPO="$REPO_OUT"; fi',
    'if [ -z "$BRANCH" ] && [ -n "$BRANCH_OUT" ]; then BRANCH="$BRANCH_OUT"; fi',
    '',
    'TRIMMED=$(printf \'%s\' "$RAW" | tr -d \'\\r\' | sed \'s/[[:space:]]*$//\')',
    'CORE=$(printf \'%s\' "$TRIMMED" | sed \'s/}[[:space:]]*$//\')',
    'EXTRA=""',
    'if [ -n "$REPO" ]; then',
    '  EXTRA="${EXTRA},\\"repo\\":\\"$(json_escape "$REPO")\\""',
    'fi',
    'if [ -n "$BRANCH" ]; then',
    '  EXTRA="${EXTRA},\\"git_branch\\":\\"$(json_escape "$BRANCH")\\""',
    'fi',
    'if [ -n "$WORKSPACE_ROOT" ]; then',
    '  EXTRA="${EXTRA},\\"workspace_root\\":\\"$(json_escape "$WORKSPACE_ROOT")\\""',
    'fi',
    '',
    'if [ "$CORE" = "{" ] || [ -z "$CORE" ]; then',
    '  BODY="{${EXTRA#,}}"',
    'else',
    '  BODY="${CORE}${EXTRA}}"',
    'fi',
    '',
    'LOG_FILE="${NEXUS_STOP_HOOK_LOG:-' +
      STOP_HOOK_LOG_FILE.replace('~', '$HOME') +
      '}"',
    '# Cloud agent homes are ephemeral; fall back to /tmp when $HOME is unset/unusable.',
    'if ! mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null; then',
    '  LOG_FILE="${TMPDIR:-/tmp}/nexus-stop-hook.log"',
    'fi',
    'STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)',
    'BODY_FILE="${TMPDIR:-/tmp}/nexus-stop-hook-$$.out"',
    '',
    '# Never block the agent on telemetry failure — but do record the outcome, so a',
    '# rejected POST (401 bypass, 404 removed deployment) is not silently lost.',
    '# Two curl forms (no bash arrays) keep this POSIX /bin/sh on Linux + macOS.',
    'if [ -n "$BYPASS" ]; then',
    "  STATUS=$(curl -sS --connect-timeout 5 --max-time 12 -X POST \"$ENDPOINT\" \\",
    '    -H "Content-Type: application/json" \\',
    '    -H "Accept: application/json" \\',
    '    -H "User-Agent: nexus-cursor-stop-hook/1.4" \\',
    '    -H "x-vercel-protection-bypass: $BYPASS" \\',
    "    --data-binary \"$BODY\" -o \"$BODY_FILE\" -w '%{http_code}' 2>/dev/null)",
    'else',
    "  STATUS=$(curl -sS --connect-timeout 5 --max-time 12 -X POST \"$ENDPOINT\" \\",
    '    -H "Content-Type: application/json" \\',
    '    -H "Accept: application/json" \\',
    '    -H "User-Agent: nexus-cursor-stop-hook/1.4" \\',
    "    --data-binary \"$BODY\" -o \"$BODY_FILE\" -w '%{http_code}' 2>/dev/null)",
    'fi',
    'if [ -z "$STATUS" ]; then STATUS="000"; fi',
    'if [ "$STATUS" = "200" ]; then',
    '  printf \'%s ok %s\\n\' "$STAMP" "$ENDPOINT" >>"$LOG_FILE" 2>/dev/null',
    'else',
    '  printf \'%s FAILED status=%s %s %s\\n\' "$STAMP" "$STATUS" "$ENDPOINT" "$(head -c 300 "$BODY_FILE" 2>/dev/null | tr -d \'\\r\\n\')" >>"$LOG_FILE" 2>/dev/null',
    'fi',
    'rm -f "$BODY_FILE" 2>/dev/null',
    '',
    'LOG_LINES=$(wc -l <"$LOG_FILE" 2>/dev/null | tr -d \'[:space:]\')',
    'if [ -n "$LOG_LINES" ] && [ "$LOG_LINES" -gt 500 ] 2>/dev/null; then',
    '  tail -n 200 "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null',
    'fi',
    '',
    '# Always succeed so a stop hook never blocks IDE or cloud agent completion.',
    "printf '%s\\n' '{}'",
    'exit 0',
    '',
  ].join('\n');

  return {
    endpoint,
    bypassConfigured,
    hooksJson,
    projectHooksJson,
    scriptFilename,
    script,
    logFile: STOP_HOOK_LOG_FILE,
    installSteps: [
      `Cloud Agents (required for cloud turns): commit \`.cursor/hooks.json\` (project snippet below) and \`.cursor/hooks/${scriptFilename}\` into each repo. Cloud VMs do not receive ~/.cursor/managed/team_*/ IDE team-hook sync — without project hooks, stop never runs in the cloud.`,
      `Local IDE (Team Hooks): script name exactly \`${scriptFilename}\` (not a title like "Cost"), event stop, OS targeting include Linux + macOS. Confirm \`ls ~/.cursor/managed/team_*/hooks/${scriptFilename}\`.`,
      `Optional: set cloud-agent secrets \`NEXUS_VERCEL_BYPASS\` and/or \`NEXUS_STOP_HOOK_ENDPOINT\` — the script prefers those over the baked-in values.`,
      `Requires POSIX sh, curl, and git. Uses CURSOR_PROJECT_DIR when cwd is not the repo root.`,
      `POST outcomes append to ${STOP_HOOK_LOG_FILE} (or /tmp if $HOME is unusable).`,
    ],
  };
}

function shellDoubleQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')}"`;
}
