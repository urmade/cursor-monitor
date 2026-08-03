import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CursorAdminClient, FilteredUsageEvent } from '@nexus/cursor-client';
import {
  lookupStopHookUsageCost,
  selectUsageEventForStopHook,
} from './hook-usage-cost';

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

  it('never prices a turn from another user’s usage event', () => {
    expect(
      selectUsageEventForStopHook(events, {
        userEmail: 'nobody@example.com',
        model: 'gpt-5',
      }),
    ).toBeNull();
  });

  it('still matches on model when the turn reports no email', () => {
    const hit = selectUsageEventForStopHook(events, {
      userEmail: null,
      model: 'composer',
    });
    expect(hit?.chargedCents).toBe(1);
  });
});

describe('lookupStopHookUsageCost', () => {
  const prev = { ...process.env };

  beforeEach(() => {
    delete process.env.CURSOR_ORGANIZATION_ID;
    delete process.env.CURSOR_ORG_ID;
    delete process.env.CURSOR_ORGANIZATION_API_KEY;
    delete process.env.CURSOR_ORG_API_KEY;
    delete process.env.CURSOR_ADMIN_API_KEY;
    delete process.env.CURSOR_TEAM_API_KEY;
    delete process.env.CURSOR_API_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...prev };
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

  it('cannot use DB/settings credentials without env or explicit overrides', async () => {
    // Stop hooks have no trusted Nexus org identity and no KV/DB mirror.
    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      fetchEvents: async () => {
        throw new Error('must not call Cursor without credentials');
      },
    });
    expect(result.chargedCents).toBeNull();
    expect(result.costLookupError).toMatch(/No Cursor Admin/i);
  });

  it('accepts explicit credential overrides (base-url validated)', async () => {
    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      organizationId: 'org_explicit',
      orgApiKey: 'explicit-org-key-xxxxxxxxxxxxx',
      baseUrl: 'https://api.cursor.com',
      fetchEvents: async (opts) => {
        expect(opts.mode).toBe('org');
        expect(opts.organizationId).toBe('org_explicit');
        return [
          {
            timestamp: String(Date.now()),
            userEmail: 'dev@example.com',
            model: 'composer',
            chargedCents: 2,
          },
        ];
      },
    });
    expect(result.chargedCents).toBe(2);
    expect(result.costSource).toBe(
      'organizations.filtered-usage-events:explicit',
    );
  });

  it('reports no cost when the turn’s user has no usage events', async () => {
    process.env.CURSOR_ORGANIZATION_ID = 'org_test';
    process.env.CURSOR_ORGANIZATION_API_KEY = 'org-key';

    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      fetchEvents: async () => [
        {
          timestamp: String(Date.now()),
          userEmail: 'someone-else@example.com',
          model: 'composer',
          chargedCents: 99,
        },
      ],
    });
    expect(result.chargedCents).toBeNull();
    expect(result.usageEvent).toBeNull();
    expect(result.costLookupError).toMatch(/No usage events for dev@example.com/);
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
