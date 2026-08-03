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
  hooksJson: string;
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
 * Pure bash + curl (+ git for repo/branch enrichment) — no language runtimes.
 * Bypass is hardcoded so non-Vercel projects can clear deployment protection.
 */
export function buildStopHookArtifact(opts: {
  baseUrl: string;
  bypass: string | null;
}): StopHookArtifact {
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/api/hooks/stop`;
  const bypass = opts.bypass ?? '';
  const bypassConfigured = bypass.length > 0;
  const scriptFilename = 'nexus-stop-to-supabase.sh';

  const hooksJson = JSON.stringify(
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
    '#!/bin/bash',
    '# Cursor stop hook — store turn metadata in Nexus (Supabase-backed Postgres).',
    '# Native macOS: bash + curl + git only. No Python/Node/jq.',
    `# Save as .cursor/hooks/${scriptFilename} and chmod +x.`,
    '',
    'set +e',
    `ENDPOINT=${shellDoubleQuote(endpoint)}`,
    `BYPASS=${shellDoubleQuote(bypass)}`,
    '',
    'json_escape() {',
    "  printf '%s' \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g' -e 's/	/\\\\t/g'",
    '}',
    '',
    'json_get_string() {',
    '  # Best-effort top-level "key":"value" extract (no jq).',
    '  local key="$1"',
    '  local src="$2"',
    '  printf \'%s\' "$src" | tr \'\\n\' \' \' | sed -n "s/.*\\"$key\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1',
    '}',
    '',
    'normalize_repo() {',
    '  local raw="$1"',
    '  raw="${raw%.git}"',
    '  case "$raw" in',
    '    git@*) raw="${raw#git@}" ;;',
    '  esac',
    '  case "$raw" in',
    '    ssh://*) raw="${raw#ssh://}" ;;',
    '    git+ssh://*) raw="${raw#git+ssh://}" ;;',
    '    http://*) raw="${raw#http://}" ;;',
    '    https://*) raw="${raw#https://}" ;;',
    '  esac',
    '  case "$raw" in',
    '    *:*) raw="${raw#*:}" ;;',
    '  esac',
    '  # Drop host segment when present (github.com/owner/repo).',
    '  local first rest',
    '  first="${raw%%/*}"',
    '  rest="${raw#*/}"',
    '  if [ "$rest" != "$raw" ] && printf \'%s\' "$first" | grep -q \'\\.\'; then',
    '    raw="$rest"',
    '  fi',
    '  printf \'%s\' "$raw"',
    '}',
    '',
    'detect_git() {',
    '  local root="$1"',
    '  REPO_OUT=""',
    '  BRANCH_OUT=""',
    '  command -v git >/dev/null 2>&1 || return 0',
    '  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0',
    '  BRANCH_OUT=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)',
    '  local remote',
    '  remote=$(git -C "$root" remote get-url origin 2>/dev/null)',
    '  if [ -n "$remote" ]; then',
    '    REPO_OUT=$(normalize_repo "$remote")',
    '  else',
    '    REPO_OUT=$(basename "$root")',
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
    'ROOT="$PWD"',
    'if [ -z "$WORKSPACE_ROOT" ]; then',
    '  WORKSPACE_ROOT=$(printf \'%s\' "$RAW" | tr \'\\n\' \' \' | sed -n \'s/.*"workspace_roots"[[:space:]]*:[[:space:]]*\\[[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | head -n 1)',
    'fi',
    'if [ -n "$WORKSPACE_ROOT" ] && [ -d "$WORKSPACE_ROOT" ]; then',
    '  ROOT="$WORKSPACE_ROOT"',
    'fi',
    '',
    'REPO_OUT=""',
    'BRANCH_OUT=""',
    'detect_git "$ROOT"',
    'if [ -z "$REPO" ] && [ -n "$REPO_OUT" ]; then REPO="$REPO_OUT"; fi',
    'if [ -z "$BRANCH" ] && [ -n "$BRANCH_OUT" ]; then BRANCH="$BRANCH_OUT"; fi',
    'if [ -z "$WORKSPACE_ROOT" ]; then WORKSPACE_ROOT="$ROOT"; fi',
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
    'CURL_ARGS=(-sS --connect-timeout 5 --max-time 12 -X POST "$ENDPOINT"',
    '  -H "Content-Type: application/json"',
    '  -H "Accept: application/json"',
    '  -H "User-Agent: nexus-cursor-stop-hook/1.2")',
    'if [ -n "$BYPASS" ]; then',
    '  CURL_ARGS+=(-H "x-vercel-protection-bypass: $BYPASS")',
    'fi',
    'CURL_ARGS+=(--data-binary "$BODY")',
    '',
    'LOG_FILE="${NEXUS_STOP_HOOK_LOG:-' +
      STOP_HOOK_LOG_FILE.replace('~', '$HOME') +
      '}"',
    'mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null',
    'STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)',
    'BODY_FILE="${TMPDIR:-/tmp}/nexus-stop-hook-$$.out"',
    '',
    '# Never block the agent on telemetry failure — but do record the outcome, so a',
    '# rejected POST (401 bypass, 404 removed deployment) is not silently lost.',
    "STATUS=$(curl \"${CURL_ARGS[@]}\" -o \"$BODY_FILE\" -w '%{http_code}' 2>/dev/null)",
    'if [ -z "$STATUS" ]; then STATUS="000"; fi',
    'if [ "$STATUS" = "200" ]; then',
    '  printf \'%s ok %s\\n\' "$STAMP" "$ENDPOINT" >>"$LOG_FILE" 2>/dev/null',
    'else',
    '  printf \'%s FAILED status=%s %s %s\\n\' "$STAMP" "$STATUS" "$ENDPOINT" "$(head -c 300 "$BODY_FILE" 2>/dev/null | tr -d \'\\r\\n\')" >>"$LOG_FILE" 2>/dev/null',
    'fi',
    'rm -f "$BODY_FILE" 2>/dev/null',
    '',
    'LOG_LINES=$(wc -l <"$LOG_FILE" 2>/dev/null | tr -d \' \')',
    'if [ -n "$LOG_LINES" ] && [ "$LOG_LINES" -gt 500 ] 2>/dev/null; then',
    '  tail -n 200 "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null',
    'fi',
    '',
    "printf '%s\\n' '{}'",
    '',
  ].join('\n');

  return {
    endpoint,
    bypassConfigured,
    hooksJson,
    scriptFilename,
    script,
    logFile: STOP_HOOK_LOG_FILE,
    installSteps: [
      `Create directory .cursor/hooks/ in your project (if missing).`,
      `Save the shell script as .cursor/hooks/${scriptFilename} and run: chmod +x .cursor/hooks/${scriptFilename}`,
      `Merge the hooks.json snippet into .cursor/hooks.json (project) or ~/.cursor/hooks.json (user).`,
      `Requires only bash, curl, and git (included with macOS). On stop, metadata plus detected repo/branch are POSTed to Nexus.`,
      `Every POST appends its HTTP status to ${STOP_HOOK_LOG_FILE} — check it (tail -n 5 ${STOP_HOOK_LOG_FILE}) when turns stop appearing in Monitoring.`,
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
