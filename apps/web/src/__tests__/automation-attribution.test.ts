import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorAdminClient } from '@nexus/cursor-client';
import {
  applyAutomationAttribution,
  loadAutomationAttributionMap,
  loadAutomationAttributionMapFromEnv,
  resolveAutomationAttributionSource,
} from '../server/automation-attribution';
import type { EnrichedAgent } from '../server/cursor';

function emptyAgent(id: string): EnrichedAgent {
  return {
    id,
    prs: [],
    cost: {
      chargedSumCents: null,
      rawSumCents: null,
      providerChargedCents: null,
      providerRawCents: null,
      runCountWithCost: 0,
      runCount: 0,
    },
  };
}

describe('automation attribution', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CURSOR_ORGANIZATION_ID;
    delete process.env.CURSOR_ORG_ID;
    delete process.env.CURSOR_ORGANIZATION_API_KEY;
    delete process.env.CURSOR_ORG_API_KEY;
    delete process.env.CURSOR_ADMIN_API_KEY;
    delete process.env.CURSOR_TEAM_API_KEY;
    delete process.env.CURSOR_API_BASE_URL;
    delete process.env.CURSOR_API_BASE_URL_ALLOWLIST;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it('applies Admin usage automation attribution onto agents', async () => {
    const admin = {
      listAllFilteredUsageEvents: async () => ({
        items: [
          {
            timestamp: '1',
            cloudAgentId: 'bc-1',
            automationId: 'auto-9',
          },
        ],
        truncated: false,
      }),
    } as unknown as CursorAdminClient;

    const map = await loadAutomationAttributionMap(admin);
    expect(map.get('bc-1')).toEqual({ automationId: 'auto-9' });

    const stamped = applyAutomationAttribution([emptyAgent('bc-1')], map);
    expect(stamped[0]!.automationId).toBe('auto-9');
    expect(stamped[0]!.source).toBe('automations');
  });

  it('prefers Organization Admin credentials over team Admin key', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_from_env';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'env-org-key-xxxxxxxxxxxxxxx';
    process.env.CURSOR_ADMIN_API_KEY = 'team-admin-key-xxxxxxxxxxxxxxx';

    const source = await resolveAutomationAttributionSource();
    expect(source?.source).toBe('org');
    expect(source?.organizationId).toBe('org_from_env');
  });

  it('falls back to team Admin key when org credentials are missing', async () => {
    process.env.CURSOR_ADMIN_API_KEY = 'team-admin-key-xxxxxxxxxxxxxxx';

    const source = await resolveAutomationAttributionSource();
    expect(source?.source).toBe('team');
    expect(source?.organizationId).toBeUndefined();
  });

  it('loads attribution via org filtered-usage-events when env org creds exist', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_from_env';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'env-org-key-xxxxxxxxxxxxxxx';

    const listEvents = vi.fn(async (_client, window) => {
      expect(window.organizationId).toBe('org_from_env');
      return {
        items: [
          {
            timestamp: '1',
            cloudAgentId: 'bc-org',
            automationId: 'auto-org',
          },
        ],
        truncated: false,
      };
    });

    // Resolve source then inject listEvents through loadAutomationAttributionMap.
    const source = await resolveAutomationAttributionSource();
    expect(source).not.toBeNull();
    const map = await loadAutomationAttributionMap(source, { listEvents });
    expect(listEvents).toHaveBeenCalledOnce();
    expect(map.get('bc-org')).toEqual({ automationId: 'auto-org' });
  });

  it('loadAutomationAttributionMapFromEnv returns empty map without credentials', async () => {
    const map = await loadAutomationAttributionMapFromEnv();
    expect(map.size).toBe(0);
  });

  it('does not overwrite an agent that already has automationId', () => {
    const map = new Map([['bc-1', { automationId: 'from-admin' }]]);
    const stamped = applyAutomationAttribution(
      [{ ...emptyAgent('bc-1'), automationId: 'from-api', source: 'api' }],
      map,
    );
    expect(stamped[0]!.automationId).toBe('from-api');
    expect(stamped[0]!.source).toBe('api');
  });
});
