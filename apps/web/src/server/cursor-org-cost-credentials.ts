import { normalizeCursorBaseUrl } from '@nexus/core';

export type OrgCostCredentials = {
  organizationId: string;
  orgApiKey: string;
  baseUrl: string;
  /** Where the credentials were resolved from. */
  source: 'env' | 'explicit';
};

function envOrgApiKey(): string | null {
  const value =
    process.env.CURSOR_ORGANIZATION_API_KEY?.trim() ||
    process.env.CURSOR_ORG_API_KEY?.trim() ||
    process.env.CURSOR_ADMIN_API_KEY?.trim() ||
    '';
  return value || null;
}

function envOrganizationId(): string | null {
  const value =
    process.env.CURSOR_ORGANIZATION_ID?.trim() ||
    process.env.CURSOR_ORG_ID?.trim() ||
    '';
  return value || null;
}

/**
 * Validate a Cursor API base URL through the shared allowlist before any
 * credentialed client is constructed.
 */
function validatedBaseUrl(raw: string | null | undefined): string | null {
  const result = normalizeCursorBaseUrl(raw);
  return result.ok ? result.value : null;
}

/**
 * Resolve Organization Admin credentials for usage/cost lookups.
 *
 * Only explicit overrides or deployment env credentials are used. There is no
 * KV/DB mirror: stop hooks have no trusted Nexus org identity, and settings
 * already store Admin keys encrypted in Postgres — duplicating them into KV
 * forced decrypt-all with no production reader.
 */
export async function resolveOrgCostCredentials(opts?: {
  organizationId?: string | null;
  orgApiKey?: string | null;
  baseUrl?: string | null;
}): Promise<OrgCostCredentials | null> {
  const explicitId = opts?.organizationId?.trim() || '';
  const explicitKey = opts?.orgApiKey?.trim() || '';
  if (explicitId.startsWith('org_') && explicitKey.length >= 20) {
    const baseUrl = validatedBaseUrl(
      opts?.baseUrl ?? process.env.CURSOR_API_BASE_URL,
    );
    if (!baseUrl) return null;
    return {
      organizationId: explicitId,
      orgApiKey: explicitKey,
      baseUrl,
      source: 'explicit',
    };
  }

  const envId = envOrganizationId();
  const envKey = envOrgApiKey();
  if (envId && envKey) {
    const baseUrl = validatedBaseUrl(process.env.CURSOR_API_BASE_URL);
    if (!baseUrl) return null;
    return {
      organizationId: envId,
      orgApiKey: envKey,
      baseUrl,
      source: 'env',
    };
  }

  return null;
}
