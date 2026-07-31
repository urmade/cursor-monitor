import { describe, expect, it, vi } from 'vitest';
import {
  createCursorOrgClient,
  discoverOrganizationId,
  normalizeOrganizationId,
} from '../org';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('normalizeOrganizationId', () => {
  it('extracts org_… tokens and rejects junk', () => {
    expect(normalizeOrganizationId('  org_abc123  ')).toBe('org_abc123');
    expect(normalizeOrganizationId('https://cursor.com/org_abc123/settings')).toBe(
      'org_abc123',
    );
    expect(normalizeOrganizationId('team_123')).toBeNull();
    expect(normalizeOrganizationId('')).toBeNull();
  });
});

describe('CursorOrgClient', () => {
  it('listMembers hits /organizations/members', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/organizations/members?page=1&pageSize=50');
      return jsonResponse(200, { members: [], organizationId: 'org_from_members' });
    });
    const client = createCursorOrgClient({ apiKey: 'org-key', fetchImpl });
    const res = await client.listMembers({ page: 1, pageSize: 50 });
    expect(res.organizationId).toBe('org_from_members');
  });

  it('pooledUsage posts organizationId', async () => {
    const fetchImpl = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        organizationId: 'org_abc123',
      });
      return jsonResponse(200, { teams: [] });
    });
    const client = createCursorOrgClient({ apiKey: 'org-key', fetchImpl });
    await client.pooledUsage('org_abc123');
  });
});

describe('discoverOrganizationId', () => {
  it('reads organizationId from /v1/me when present', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/v1/me');
      return jsonResponse(200, {
        apiKeyName: 'Org',
        organizationId: 'org_from_me',
      });
    });
    const result = await discoverOrganizationId({
      apiKey: 'k',
      fetchImpl,
    });
    expect(result.organizationId).toBe('org_from_me');
    expect(result.source).toBe('me');
  });

  it('falls back to /organizations/members', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/me')) {
        return jsonResponse(200, { apiKeyName: 'Org' });
      }
      if (url.includes('/organizations/members')) {
        return jsonResponse(200, { organizationId: 'org_members', members: [] });
      }
      return jsonResponse(404, { message: 'nope' });
    });
    const result = await discoverOrganizationId({
      apiKey: 'org-key',
      fetchImpl,
    });
    expect(result.organizationId).toBe('org_members');
    expect(result.source).toBe('members');
  });

  it('returns null with a note when nothing exposes an org id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { message: 'Invalid API Key' }),
    );
    const result = await discoverOrganizationId({
      apiKey: 'personal-key',
      fetchImpl,
    });
    expect(result.organizationId).toBeNull();
    expect(result.source).toBeNull();
    expect(result.note).toMatch(/dashboard/i);
  });

  it('scrapes org id from pooled-usage error bodies', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/me')) {
        return jsonResponse(401, { message: 'Invalid' });
      }
      if (url.includes('/organizations/members')) {
        return jsonResponse(401, { message: 'Invalid Organization API Key' });
      }
      if (url.includes('/organizations/groups')) {
        return jsonResponse(401, { message: 'Invalid Organization API Key' });
      }
      if (url.includes('/organizations/pooled-usage')) {
        return jsonResponse(403, {
          message: 'organization does not match the key for org_error_probe',
        });
      }
      return jsonResponse(404, {});
    });
    const result = await discoverOrganizationId({
      apiKey: 'org-key',
      fetchImpl,
    });
    expect(result.organizationId).toBe('org_error_probe');
    expect(result.source).toBe('pooled_usage');
  });
});
