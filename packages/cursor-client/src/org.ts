import { CursorClient, type CursorClientOptions } from './client';
import type {
  OrganizationGroupsResponse,
  OrganizationMembersResponse,
  OrganizationPooledUsageResponse,
} from './types';

const ORG_ID_RE = /org_[A-Za-z0-9_]+/;
const DEFAULT_BASE_URL = 'https://api.cursor.com';

/** Organization Admin API client (Organization API key + optional org id). */
export class CursorOrgClient extends CursorClient {
  constructor(opts: CursorClientOptions) {
    super(opts);
  }

  async listMembers(opts?: {
    page?: number;
    pageSize?: number;
  }): Promise<OrganizationMembersResponse> {
    const params = new URLSearchParams();
    if (opts?.page !== undefined) params.set('page', String(opts.page));
    if (opts?.pageSize !== undefined) params.set('pageSize', String(opts.pageSize));
    const qs = params.toString() ? `?${params}` : '';
    return this.request<OrganizationMembersResponse>(
      'GET',
      `/organizations/members${qs}`,
    );
  }

  async listGroups(opts?: {
    page?: number;
    pageSize?: number;
  }): Promise<OrganizationGroupsResponse> {
    const params = new URLSearchParams();
    if (opts?.page !== undefined) params.set('page', String(opts.page));
    if (opts?.pageSize !== undefined) params.set('pageSize', String(opts.pageSize));
    const qs = params.toString() ? `?${params}` : '';
    return this.request<OrganizationGroupsResponse>(
      'GET',
      `/organizations/groups${qs}`,
    );
  }

  async pooledUsage(organizationId: string): Promise<OrganizationPooledUsageResponse> {
    return this.request<OrganizationPooledUsageResponse>(
      'POST',
      '/organizations/pooled-usage',
      { organizationId },
    );
  }
}

export function createCursorOrgClient(
  opts: CursorClientOptions,
): CursorOrgClient {
  return new CursorOrgClient(opts);
}

export type DiscoverOrganizationIdResult = {
  /** Public Cursor organization id (`org_…`) when found. */
  organizationId: string | null;
  /** Which probe produced the id. */
  source: 'me' | 'members' | 'groups' | 'pooled_usage' | null;
  /** Human-readable note when discovery fails or partially succeeds. */
  note: string | null;
};

function firstOrgIdInValue(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const match = value.match(ORG_ID_RE);
    return match?.[0] ?? null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstOrgIdInValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of [
      'organizationId',
      'organisationId',
      'orgId',
      'organization_id',
      'org_id',
    ]) {
      const direct = record[key];
      if (typeof direct === 'string') {
        const match = direct.match(ORG_ID_RE);
        if (match) return match[0]!;
      }
    }
    for (const nested of Object.values(record)) {
      const found = firstOrgIdInValue(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Best-effort lookup of the public organization id bound to an API key.
 *
 * Cursor's documented Organization Admin routes require `organizationId` as an
 * input and do not expose a dedicated "whoami" that returns it. We still probe
 * `/v1/me` and the org routes that authenticate from the key alone, and scan
 * responses (and some error bodies) for an `org_…` id.
 *
 * Personal / Cloud Agents keys typically cannot discover an org id — the admin
 * must paste it from the Cursor organisation dashboard URL.
 */
export async function discoverOrganizationId(opts: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<DiscoverOrganizationIdResult> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const client = createCursorOrgClient({
    apiKey: opts.apiKey,
    baseUrl,
    fetchImpl: opts.fetchImpl,
    maxRetries: 0,
  });

  try {
    const me = await client.getMe();
    const fromMe = firstOrgIdInValue(me);
    if (fromMe) {
      return {
        organizationId: fromMe,
        source: 'me',
        note: 'Resolved organization id from GET /v1/me.',
      };
    }
  } catch {
    // Key may be org-scoped and reject /v1/me — continue with org probes.
  }

  let sawUsageScopedKey = false;

  try {
    const members = await client.listMembers({ page: 1, pageSize: 1 });
    const fromMembers = firstOrgIdInValue(members);
    if (fromMembers) {
      return {
        organizationId: fromMembers,
        source: 'members',
        note: 'Resolved organization id from GET /organizations/members.',
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/organization\.(members|groups)\.read|usage:\*/i.test(message)) {
      sawUsageScopedKey = true;
    }
    // Not an Organization API key, or missing members scope.
  }

  try {
    const groups = await client.listGroups({ page: 1, pageSize: 1 });
    const fromGroups = firstOrgIdInValue(groups);
    if (fromGroups) {
      return {
        organizationId: fromGroups,
        source: 'groups',
        note: 'Resolved organization id from GET /organizations/groups.',
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/organization\.(members|groups)\.read|usage:\*/i.test(message)) {
      sawUsageScopedKey = true;
    }
    // Not an Organization API key, or missing members scope.
  }

  // Some error payloads mention the bound organization id; probe pooled-usage
  // without a valid id and scan the error body.
  try {
    await client.pooledUsage('');
  } catch (err) {
    const body =
      err && typeof err === 'object' && 'body' in err
        ? (err as { body: unknown }).body
        : err instanceof Error
          ? err.message
          : null;
    const fromError = firstOrgIdInValue(body);
    if (fromError) {
      return {
        organizationId: fromError,
        source: 'pooled_usage',
        note: 'Resolved organization id from an Organization API error payload.',
      };
    }
  }

  return {
    organizationId: null,
    source: null,
    note: sawUsageScopedKey
      ? 'This Organization API key appears usage-scoped (usage:*). It can fetch pooled usage and cost events, but cannot discover the public org id. Paste org_… from the Cursor organisation dashboard URL.'
      : 'Cursor does not expose a documented whoami for organization id. Paste the org id from the Cursor organisation dashboard URL (org_…).',
  };
}

/** Normalize / validate a public organization id (`org_…`). */
export function normalizeOrganizationId(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  const match = value.match(ORG_ID_RE);
  return match?.[0] ?? null;
}

export function defaultCursorApiBaseUrl(): string {
  return DEFAULT_BASE_URL;
}
