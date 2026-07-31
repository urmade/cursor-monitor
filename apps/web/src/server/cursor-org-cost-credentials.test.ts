import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetMemoryKv } from '@nexus/core';
import {
  costEntriesFromOrganisations,
  readOrgCostCredentialsStore,
  resolveOrgCostCredentials,
  writeOrgCostCredentialsStore,
} from '../server/cursor-org-cost-credentials';
import type { StoredCursorOrganisation } from '../server/cursor-org-store';

describe('cursor org cost credentials', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    resetMemoryKv();
    delete process.env.CURSOR_ORGANIZATION_ID;
    delete process.env.CURSOR_ORG_ID;
    delete process.env.CURSOR_ORGANIZATION_API_KEY;
    delete process.env.CURSOR_ORG_API_KEY;
    delete process.env.CURSOR_ADMIN_API_KEY;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
    resetMemoryKv();
  });

  it('extracts cost-capable entries from stored organisations', () => {
    const orgs: StoredCursorOrganisation[] = [
      {
        id: '1',
        label: 'No cost',
        organizationId: 'org_abc',
        apiKey: 'cursor_user_key_aaaaaaaaaaaa',
        orgApiKey: null,
        baseUrl: 'https://api.cursor.com',
      },
      {
        id: '2',
        label: 'With cost',
        organizationId: 'org_Ql4KK4BASeB0rdea',
        apiKey: 'cursor_user_key_bbbbbbbbbbbb',
        orgApiKey: 'crsr_org_key_cccccccccccccccccccc',
        baseUrl: 'https://api.cursor.com',
      },
    ];
    expect(costEntriesFromOrganisations(orgs)).toEqual([
      {
        organizationId: 'org_Ql4KK4BASeB0rdea',
        orgApiKey: 'crsr_org_key_cccccccccccccccccccc',
        baseUrl: 'https://api.cursor.com',
      },
    ]);
  });

  it('prefers env credentials over server store', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_from_env';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'env-org-key-xxxxxxxxxxxxxxx';
    await writeOrgCostCredentialsStore([
      {
        id: '1',
        label: 'Stored',
        organizationId: 'org_stored',
        apiKey: 'cursor_user_key_bbbbbbbbbbbb',
        orgApiKey: 'stored-org-key-xxxxxxxxxxxxxxx',
        baseUrl: 'https://api.cursor.com',
      },
    ]);

    const resolved = await resolveOrgCostCredentials();
    expect(resolved?.source).toBe('env');
    expect(resolved?.organizationId).toBe('org_from_env');
    expect(resolved?.orgApiKey).toBe('env-org-key-xxxxxxxxxxxxxxx');
  });

  it('falls back to server store when env is unset', async () => {
    await writeOrgCostCredentialsStore([
      {
        id: '1',
        label: 'Stored',
        organizationId: 'org_stored',
        apiKey: 'cursor_user_key_bbbbbbbbbbbb',
        orgApiKey: 'stored-org-key-xxxxxxxxxxxxxxx',
        baseUrl: 'https://api.cursor.com',
      },
    ]);

    const resolved = await resolveOrgCostCredentials({ envOnly: false });
    expect(resolved?.source).toBe('server_store');
    expect(resolved?.organizationId).toBe('org_stored');

    const stored = await readOrgCostCredentialsStore();
    expect(stored).toHaveLength(1);
  });

  it('accepts explicit overrides', async () => {
    const resolved = await resolveOrgCostCredentials({
      organizationId: 'org_explicit',
      orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
      baseUrl: 'https://api.example.com/',
    });
    expect(resolved).toEqual({
      organizationId: 'org_explicit',
      orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
      baseUrl: 'https://api.example.com',
      source: 'explicit',
    });
  });

  it('clears server store when no cost-capable orgs remain', async () => {
    await writeOrgCostCredentialsStore([
      {
        id: '1',
        label: 'Stored',
        organizationId: 'org_stored',
        apiKey: 'cursor_user_key_bbbbbbbbbbbb',
        orgApiKey: 'stored-org-key-xxxxxxxxxxxxxxx',
        baseUrl: 'https://api.cursor.com',
      },
    ]);
    await writeOrgCostCredentialsStore([]);
    expect(await readOrgCostCredentialsStore()).toEqual([]);
  });
});
