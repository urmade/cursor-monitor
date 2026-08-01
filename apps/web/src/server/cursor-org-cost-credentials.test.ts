import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveOrgCostCredentials } from '../server/cursor-org-cost-credentials';

describe('cursor org cost credentials', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CURSOR_ORGANIZATION_ID;
    delete process.env.CURSOR_ORG_ID;
    delete process.env.CURSOR_ORGANIZATION_API_KEY;
    delete process.env.CURSOR_ORG_API_KEY;
    delete process.env.CURSOR_ADMIN_API_KEY;
    delete process.env.CURSOR_API_BASE_URL;
    delete process.env.CURSOR_API_BASE_URL_ALLOWLIST;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it('resolves deployment env credentials when baseUrl is allowlisted', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_from_env';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'env-org-key-xxxxxxxxxxxxxxx';

    const resolved = await resolveOrgCostCredentials();
    expect(resolved).toEqual({
      organizationId: 'org_from_env',
      orgApiKey: 'env-org-key-xxxxxxxxxxxxxxx',
      baseUrl: 'https://api.cursor.com',
      source: 'env',
    });
  });

  it('accepts explicit overrides only when baseUrl is allowlisted', async () => {
    const resolved = await resolveOrgCostCredentials({
      organizationId: 'org_explicit',
      orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
      baseUrl: 'https://api.cursor.com/',
    });
    expect(resolved).toEqual({
      organizationId: 'org_explicit',
      orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
      baseUrl: 'https://api.cursor.com',
      source: 'explicit',
    });

    expect(
      await resolveOrgCostCredentials({
        organizationId: 'org_explicit',
        orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
        baseUrl: 'https://evil.example',
      }),
    ).toBeNull();
  });

  it('prefers explicit overrides over env', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_from_env';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'env-org-key-xxxxxxxxxxxxxxx';

    const resolved = await resolveOrgCostCredentials({
      organizationId: 'org_explicit',
      orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
      baseUrl: 'https://api.cursor.com',
    });
    expect(resolved?.source).toBe('explicit');
    expect(resolved?.organizationId).toBe('org_explicit');
  });

  it('rejects env credentials when CURSOR_API_BASE_URL is not allowlisted', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_from_env';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'env-org-key-xxxxxxxxxxxxxxx';
    process.env.CURSOR_API_BASE_URL = 'https://evil.example';
    expect(await resolveOrgCostCredentials()).toBeNull();
  });

  it('returns null when neither explicit nor env credentials are configured', async () => {
    expect(await resolveOrgCostCredentials()).toBeNull();
  });

  it('does not consult DB/KV — unknown tenant opts cannot unlock credentials', async () => {
    // Extra fields are ignored; without explicit/env secrets resolution is null.
    expect(
      await resolveOrgCostCredentials({
        organizationId: null,
        orgApiKey: null,
        baseUrl: null,
      }),
    ).toBeNull();
  });
});
