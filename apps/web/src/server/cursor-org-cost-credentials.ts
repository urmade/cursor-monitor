import { kvDel, kvGet, kvSet } from '@nexus/core';
import {
  readCursorOrganisations,
  type StoredCursorOrganisation,
} from './cursor-org-store';

/** Server-side mirror of org Admin cost credentials (stop hooks have no browser cookies). */
export const ORG_COST_CREDENTIALS_KV_KEY = 'nexus:cursor-org-cost-credentials';

export type OrgCostCredentials = {
  organizationId: string;
  orgApiKey: string;
  baseUrl: string;
  /** Where the credentials were resolved from. */
  source: 'env' | 'server_store' | 'cookie' | 'explicit';
};

export type OrgCostCredentialEntry = {
  organizationId: string;
  orgApiKey: string;
  baseUrl: string;
};

type StoredOrgCostCredentials = {
  entries: OrgCostCredentialEntry[];
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

function envBaseUrl(): string {
  return (
    process.env.CURSOR_API_BASE_URL?.trim().replace(/\/$/, '') ||
    'https://api.cursor.com'
  );
}

function entryFromOrg(
  org: Pick<StoredCursorOrganisation, 'organizationId' | 'orgApiKey' | 'baseUrl'>,
): OrgCostCredentialEntry | null {
  const organizationId = org.organizationId?.trim() || '';
  const orgApiKey = org.orgApiKey?.trim() || '';
  if (!organizationId.startsWith('org_') || orgApiKey.length < 20) return null;
  return {
    organizationId,
    orgApiKey,
    baseUrl: org.baseUrl || 'https://api.cursor.com',
  };
}

export function costEntriesFromOrganisations(
  orgs: StoredCursorOrganisation[],
): OrgCostCredentialEntry[] {
  const out: OrgCostCredentialEntry[] = [];
  const seen = new Set<string>();
  for (const org of orgs) {
    const entry = entryFromOrg(org);
    if (!entry) continue;
    const key = `${entry.organizationId}:${entry.orgApiKey.slice(0, 12)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Persist org Admin cost credentials for stop-hook / server-side lookups. */
export async function writeOrgCostCredentialsStore(
  orgs: StoredCursorOrganisation[],
): Promise<void> {
  const entries = costEntriesFromOrganisations(orgs);
  if (entries.length === 0) {
    await kvDel(ORG_COST_CREDENTIALS_KV_KEY);
    return;
  }
  const payload: StoredOrgCostCredentials = { entries };
  await kvSet(ORG_COST_CREDENTIALS_KV_KEY, JSON.stringify(payload));
}

export async function readOrgCostCredentialsStore(): Promise<
  OrgCostCredentialEntry[]
> {
  const raw = await kvGet(ORG_COST_CREDENTIALS_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredOrgCostCredentials;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (row) =>
        typeof row?.organizationId === 'string' &&
        row.organizationId.startsWith('org_') &&
        typeof row?.orgApiKey === 'string' &&
        row.orgApiKey.length >= 20 &&
        typeof row?.baseUrl === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Resolve Organization Admin credentials for usage/cost lookups.
 *
 * Priority: explicit override → env → server store (Redis/memory) → cookie orgs.
 * Stop hooks have no browser cookie, so settings save mirrors keys into the
 * server store (and env secrets remain the durable deploy path).
 */
export async function resolveOrgCostCredentials(opts?: {
  organizationId?: string | null;
  orgApiKey?: string | null;
  baseUrl?: string | null;
  /** Skip cookie/server reads (unit tests). */
  envOnly?: boolean;
}): Promise<OrgCostCredentials | null> {
  const explicitId = opts?.organizationId?.trim() || '';
  const explicitKey = opts?.orgApiKey?.trim() || '';
  if (explicitId.startsWith('org_') && explicitKey.length >= 20) {
    return {
      organizationId: explicitId,
      orgApiKey: explicitKey,
      baseUrl: (opts?.baseUrl?.trim() || envBaseUrl()).replace(/\/$/, ''),
      source: 'explicit',
    };
  }

  const envId = envOrganizationId();
  const envKey = envOrgApiKey();
  if (envId && envKey) {
    return {
      organizationId: envId,
      orgApiKey: envKey,
      baseUrl: envBaseUrl(),
      source: 'env',
    };
  }

  if (opts?.envOnly) return null;

  const stored = await readOrgCostCredentialsStore();
  if (stored[0]) {
    return { ...stored[0], source: 'server_store' };
  }

  try {
    const orgs = await readCursorOrganisations();
    const fromCookie = costEntriesFromOrganisations(orgs);
    if (fromCookie[0]) {
      return { ...fromCookie[0], source: 'cookie' };
    }
  } catch {
    // cookies() unavailable outside a Next.js request (e.g. some tests).
  }

  return null;
}
