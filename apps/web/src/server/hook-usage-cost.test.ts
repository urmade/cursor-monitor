import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CursorAdminClient, FilteredUsageEvent } from '@nexus/cursor-client';
import { resetMemoryKv } from '@nexus/core';
import {
  lookupStopHookUsageCost,
  selectUsageEventForStopHook,
} from './hook-usage-cost';
import { writeOrgCostCredentialsStore } from './cursor-org-cost-credentials';

describe('selectUsageEventForStopHook', () => {
  const events: FilteredUsageEvent[] = [
    {
      timestamp: '1000',
      userEmail: 'a@example.com',
      model: 'composer',
      chargedCents: 1,
    },
    {
      timestamp: '2000',
      userEmail: 'a@example.com',
      model: 'gpt-5',
      chargedCents: 9.5,
    },
    {
      timestamp: '3000',
      userEmail: 'b@example.com',
      model: 'gpt-5',
      chargedCents: 3,
    },
  ];

  it('prefers email + model match, then newest', () => {
    const hit = selectUsageEventForStopHook(events, {
      userEmail: 'a@example.com',
      model: 'gpt-5',
    });
    expect(hit?.chargedCents).toBe(9.5);
  });

  it('falls back to newest for email when model missing', () => {
    const hit = selectUsageEventForStopHook(events, {
      userEmail: 'a@example.com',
      model: null,
    });
    expect(hit?.timestamp).toBe('2000');
  });
});

describe('lookupStopHookUsageCost', () => {
  const prev = { ...process.env };

  beforeEach(() => {
    resetMemoryKv();
    delete process.env.CURSOR_ORGANIZATION_ID;
    delete process.env.CURSOR_ORG_ID;
    delete process.env.CURSOR_ORGANIZATION_API_KEY;
    delete process.env.CURSOR_ORG_API_KEY;
    delete process.env.CURSOR_ADMIN_API_KEY;
    delete process.env.CURSOR_TEAM_API_KEY;
  });

  afterEach(() => {
    process.env = { ...prev };
    resetMemoryKv();
  });

  it('uses org filtered-usage-events when org id + key are set', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_test';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'org-key';

    const fetchEvents = vi.fn(async () => [
      {
        timestamp: String(Date.now()),
        userEmail: 'dev@example.com',
        model: 'composer',
        chargedCents: 12.34,
        teamId: 1,
      } satisfies FilteredUsageEvent,
    ]);

    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      fetchEvents: async (opts) => {
        expect(opts.mode).toBe('org');
        expect(opts.organizationId).toBe('org_test');
        expect(opts.email).toBe('dev@example.com');
        void (opts.client as CursorAdminClient);
        return fetchEvents();
      },
    });
    expect(result.chargedCents).toBe(12.34);
    expect(result.costSource).toBe(
      'organizations.filtered-usage-events:env',
    );
    expect(result.costLookupError).toBeNull();
    expect(result.usageEvent?.chargedCents).toBe(12.34);
  });

  it('uses server-store credentials synced from organisation settings', async () => {
    await writeOrgCostCredentialsStore([
      {
        id: '1',
        label: 'Acme',
        organizationId: 'org_from_settings',
        apiKey: 'cursor_user_key_bbbbbbbbbbbb',
        orgApiKey: 'settings-org-key-xxxxxxxxxxxx',
        baseUrl: 'https://api.cursor.com',
      },
    ]);

    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      fetchEvents: async (opts) => {
        expect(opts.mode).toBe('org');
        expect(opts.organizationId).toBe('org_from_settings');
        return [
          {
            timestamp: String(Date.now()),
            userEmail: 'dev@example.com',
            model: 'composer',
            chargedCents: 4.2,
          },
        ];
      },
    });
    expect(result.chargedCents).toBe(4.2);
    expect(result.costSource).toBe(
      'organizations.filtered-usage-events:server_store',
    );
  });

  it('returns a soft error when no API key is configured', async () => {
    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: null,
    });
    expect(result.chargedCents).toBeNull();
    expect(result.costLookupError).toMatch(/No Cursor Admin/i);
  });
});
