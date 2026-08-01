import { coreError, type CoreError } from '../errors';
import { err, ok, type Result } from '../result';

/** Production default — the only destination unless an allowlist adds more. */
export const DEFAULT_CURSOR_API_BASE_URL = 'https://api.cursor.com';

/**
 * Server-side allowlist of additional exact HTTPS Cursor API origins.
 * Comma-separated, e.g. `https://api-staging.example.com,https://cursor-api.corp.example`.
 * Entries must themselves be exact origins (https, no path/query/port/userinfo).
 */
export const CURSOR_API_BASE_URL_ALLOWLIST_ENV = 'CURSOR_API_BASE_URL_ALLOWLIST';

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1']);

export type NormalizeCursorBaseUrlOptions = {
  /**
   * Extra exact origins to allow. When omitted, reads
   * {@link CURSOR_API_BASE_URL_ALLOWLIST_ENV} from the environment.
   */
  allowlist?: readonly string[];
  /**
   * Force production rules (no HTTP, no localhost). When omitted, inferred
   * from NODE_ENV / Vercel env markers.
   */
  isProduction?: boolean;
};

function isProductionEnv(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL === '1' ||
    process.env.VERCEL_ENV === 'production'
  );
}

function validationError(message: string): Result<string, CoreError> {
  return err(coreError('validation', message));
}

/**
 * Parse a candidate origin string into a canonical `protocol://host` form,
 * rejecting paths, query, fragments, userinfo, and non-default ports.
 * Does not apply allowlist policy — only structural origin checks.
 */
function parseExactOrigin(
  raw: string,
  opts: { allowHttp: boolean },
): Result<string, CoreError> {
  const value = raw.trim();
  if (!value) {
    return validationError('Cursor API base URL must not be empty.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return validationError('Cursor API base URL is not a valid URL.');
  }

  if (url.username || url.password) {
    return validationError(
      'Cursor API base URL must not include credentials (userinfo).',
    );
  }

  if (url.search || url.hash) {
    return validationError(
      'Cursor API base URL must not include a query string or fragment.',
    );
  }

  const path = url.pathname;
  if (path !== '' && path !== '/') {
    return validationError(
      'Cursor API base URL must be an exact origin (no path).',
    );
  }

  // URL.port is '' when the port is the scheme default (80/443).
  if (url.port !== '') {
    return validationError(
      'Cursor API base URL must not include a non-default port.',
    );
  }

  if (url.protocol === 'https:') {
    // ok
  } else if (url.protocol === 'http:') {
    if (!opts.allowHttp) {
      return validationError('Cursor API base URL must use HTTPS.');
    }
  } else {
    return validationError('Cursor API base URL must use HTTPS.');
  }

  const host = url.hostname;
  if (!host) {
    return validationError('Cursor API base URL is missing a host.');
  }

  // Reject trailing-dot / odd host forms that are not exact allowlist matches.
  if (host.endsWith('.')) {
    return validationError('Cursor API base URL host is not allowed.');
  }

  return ok(`${url.protocol}//${host}`);
}

function readAllowlistFromEnv(): string[] {
  const raw = process.env[CURSOR_API_BASE_URL_ALLOWLIST_ENV]?.trim() ?? '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Build the set of canonical origins permitted for credentialed Cursor API calls.
 */
export function allowedCursorApiBaseUrls(
  options?: NormalizeCursorBaseUrlOptions,
): Set<string> {
  const isProd = options?.isProduction ?? isProductionEnv();
  const allowed = new Set<string>([DEFAULT_CURSOR_API_BASE_URL]);

  const entries =
    options?.allowlist !== undefined
      ? options.allowlist
      : readAllowlistFromEnv();

  for (const entry of entries) {
    // Allowlist entries are always HTTPS exact origins (never HTTP/localhost via this path).
    const parsed = parseExactOrigin(entry, { allowHttp: false });
    if (parsed.ok && parsed.value.startsWith('https:')) {
      allowed.add(parsed.value);
    }
  }

  if (!isProd) {
    for (const host of LOCALHOST_HOSTS) {
      allowed.add(`http://${host}`);
      allowed.add(`https://${host}`);
    }
  }

  return allowed;
}

/**
 * Normalize and validate a Cursor API base URL used with Authorization headers.
 *
 * - Empty / missing → {@link DEFAULT_CURSOR_API_BASE_URL}
 * - Otherwise must be an exact allowed HTTPS origin (default `https://api.cursor.com`,
 *   plus {@link CURSOR_API_BASE_URL_ALLOWLIST_ENV})
 * - Rejects (does not rewrite) paths, query, fragments, userinfo, non-default ports,
 *   HTTP (except explicit localhost in non-production), and host suffix/subdomain tricks
 */
export function normalizeCursorBaseUrl(
  raw: string | null | undefined,
  options?: NormalizeCursorBaseUrlOptions,
): Result<string, CoreError> {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return ok(DEFAULT_CURSOR_API_BASE_URL);
  }

  const isProd = options?.isProduction ?? isProductionEnv();
  const structural = parseExactOrigin(trimmed, {
    // Structural parse may allow http only so we can accept localhost in non-prod;
    // policy below still rejects http to non-localhost and all http in production.
    allowHttp: !isProd,
  });
  if (!structural.ok) return structural;

  const canonical = structural.value;
  const allowed = allowedCursorApiBaseUrls(options);
  if (!allowed.has(canonical)) {
    return validationError(
      'Cursor API base URL is not an allowed origin. Use https://api.cursor.com or an origin listed in CURSOR_API_BASE_URL_ALLOWLIST.',
    );
  }

  return ok(canonical);
}
