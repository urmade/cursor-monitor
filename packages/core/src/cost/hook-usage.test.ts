import { describe, expect, it, vi } from 'vitest';
import type { FilteredUsageEvent } from '@nexus/cursor-client';
import {
  HOOK_COST_PENDING_SOURCE,
  HOOK_COST_TEAM_SOURCE,
  fetchAllTeamUsageEvents,
  lookupFromUsageEvents,
  lookupStopHookUsageCost,
  matchPendingHooksToUsageEvents,
  reconcileStopHookUsageCosts,
  reconcileStopHookUsageCostsFromFirstHook,
  selectUsageEventForStopHook,
  usageEventFingerprint,
  type PendingHookCostRow,
  type TeamCostCredential,
} from './hook-usage';

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

describe('selectUsageEventForStopHook', () => {
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

  it('skips already-consumed usage events', () => {
    const first = selectUsageEventForStopHook(events, {
      userEmail: 'a@example.com',
      model: 'gpt-5',
    });
    expect(first).not.toBeNull();
    const second = selectUsageEventForStopHook(events, {
      userEmail: 'a@example.com',
      model: 'gpt-5',
      excludeFingerprints: new Set([usageEventFingerprint(first!)]),
    });
    expect(second?.chargedCents).toBe(1);
  });

  it('picks the event closest to the hook time when anchored', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const windowed: FilteredUsageEvent[] = [
      {
        timestamp: String(now - 60 * 60 * 1000),
        userEmail: 'a@example.com',
        model: 'gpt-5',
        chargedCents: 1,
      },
      {
        timestamp: String(now - 2 * 60 * 1000),
        userEmail: 'a@example.com',
        model: 'gpt-5',
        chargedCents: 9,
      },
      {
        timestamp: String(now + 30 * 60 * 1000),
        userEmail: 'a@example.com',
        model: 'gpt-5',
        chargedCents: 99,
      },
    ];
    const hit = selectUsageEventForStopHook(windowed, {
      userEmail: 'a@example.com',
      model: 'gpt-5',
      anchorMs: now,
      maxDistanceMs: 6 * 60 * 60 * 1000,
    });
    expect(hit?.chargedCents).toBe(9);
  });
});

describe('lookupStopHookUsageCost', () => {
  const cred: TeamCostCredential = {
    apiKey: 'team-key-abcdefghijklmnopqrst',
    baseUrl: 'https://api.cursor.com',
    source: 'db',
    label: 'Acme · Team',
  };

  it('uses team filtered-usage-events when a team key is provided', async () => {
    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      credentials: [cred],
      fetchEvents: async () => [
        {
          timestamp: String(Date.now()),
          userEmail: 'dev@example.com',
          model: 'composer',
          chargedCents: 12.34,
        },
      ],
    });
    expect(result.chargedCents).toBe(12.34);
    expect(result.costSource).toBe(`${HOOK_COST_TEAM_SOURCE}:db`);
    expect(result.costLookupError).toBeNull();
  });

  it('reports a configuration error when no team key is configured', async () => {
    const result = await lookupStopHookUsageCost({
      userEmail: 'dev@example.com',
      model: 'composer',
      credentials: [],
      fetchEvents: async () => {
        throw new Error('must not call Cursor without credentials');
      },
    });
    expect(result.chargedCents).toBeNull();
    expect(result.costLookupError).toMatch(/No Cursor Team API key/i);
  });
});

describe('matchPendingHooksToUsageEvents', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');

  it('assigns each usage event to at most one pending hook', () => {
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'a@example.com',
        model: 'gpt-5',
        receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
        finishedAt: null,
      },
      {
        id: 'h2',
        userEmail: 'a@example.com',
        model: 'gpt-5',
        receivedAt: new Date(now.getTime() - 9 * 60 * 1000),
        finishedAt: null,
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events,
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 5 * 60 * 1000,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(matched[0]?.lookup.chargedCents).toBe(9.5);
    expect(matched[1]?.lookup.chargedCents).toBe(1);
  });

  it('keeps recent unmatched hooks pending instead of failing', () => {
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'nobody@example.com',
        model: 'gpt-5',
        receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
        finishedAt: null,
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events,
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 5 * 60 * 1000,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(matched[0]?.lookup.chargedCents).toBeNull();
    expect(matched[0]?.lookup.costSource).toBe(HOOK_COST_PENDING_SOURCE);
    expect(matched[0]?.lookup.costLookupError).toBeNull();
    expect(matched[0]?.expired).toBe(false);
  });

  it('expires unmatched hooks after the max age', () => {
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'nobody@example.com',
        model: 'gpt-5',
        receivedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        finishedAt: null,
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events,
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 5 * 60 * 1000,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(matched[0]?.expired).toBe(true);
    expect(matched[0]?.lookup.costLookupError).toMatch(/6 hours/);
  });

  it('does not expire unmatched hooks when expireUnmatched is false', () => {
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'nobody@example.com',
        model: 'gpt-5',
        receivedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        finishedAt: null,
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events,
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 0,
      maxAgeMs: 6 * 60 * 60 * 1000,
      expireUnmatched: false,
    });
    expect(matched[0]?.expired).toBe(false);
    expect(matched[0]?.lookup.costSource).toBe(HOOK_COST_PENDING_SOURCE);
    expect(matched[0]?.lookup.costLookupError).toBeNull();
  });

  it('sums every usage event that shares the hook conversationId', () => {
    const conv = '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b';
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'a@example.com',
        model: 'gpt-5',
        conversationId: conv,
        receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
        finishedAt: new Date(now.getTime() - 10 * 60 * 1000),
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events: [
        {
          timestamp: String(now.getTime() - 12 * 60 * 1000),
          userEmail: 'a@example.com',
          conversationId: conv,
          model: 'gpt-5',
          chargedCents: 21.36,
        },
        {
          timestamp: String(now.getTime() - 11 * 60 * 1000),
          userEmail: 'a@example.com',
          conversationId: conv,
          model: 'claude-4.5-sonnet',
          chargedCents: 37.33,
        },
        {
          timestamp: String(now.getTime() - 9 * 60 * 1000),
          userEmail: 'a@example.com',
          conversationId: 'other-conversation',
          model: 'gpt-5',
          chargedCents: 999,
        },
      ],
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 0,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(matched[0]?.lookup.chargedCents).toBeCloseTo(58.69);
    expect(matched[0]?.lookup.costSource).toMatch(/conversationId/);
  });

  it('does not price a hook from a different conversation’s usage events', () => {
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'a@example.com',
        model: 'gpt-5',
        conversationId: 'hook-conv',
        receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
        finishedAt: null,
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events: [
        {
          timestamp: String(now.getTime() - 10 * 60 * 1000),
          userEmail: 'a@example.com',
          conversationId: 'other-conv',
          model: 'gpt-5',
          chargedCents: 50,
        },
      ],
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 0,
      maxAgeMs: 6 * 60 * 60 * 1000,
      expireUnmatched: false,
    });
    expect(matched[0]?.lookup.chargedCents).toBeNull();
    expect(matched[0]?.lookup.costSource).toBe(HOOK_COST_PENDING_SOURCE);
  });

  it('splits same-conversation events across consecutive hooks by nearest time', () => {
    const conv = 'conv-split';
    const t1 = new Date(now.getTime() - 20 * 60 * 1000);
    const t2 = new Date(now.getTime() - 5 * 60 * 1000);
    const pending: PendingHookCostRow[] = [
      {
        id: 'h1',
        userEmail: 'a@example.com',
        model: 'gpt-5',
        conversationId: conv,
        receivedAt: t1,
        finishedAt: t1,
      },
      {
        id: 'h2',
        userEmail: 'a@example.com',
        model: 'gpt-5',
        conversationId: conv,
        receivedAt: t2,
        finishedAt: t2,
      },
    ];
    const matched = matchPendingHooksToUsageEvents({
      pending,
      events: [
        {
          timestamp: String(t1.getTime() - 30_000),
          userEmail: 'a@example.com',
          conversationId: conv,
          chargedCents: 10,
        },
        {
          timestamp: String(t2.getTime() - 30_000),
          userEmail: 'a@example.com',
          conversationId: conv,
          chargedCents: 40,
        },
      ],
      source: HOOK_COST_TEAM_SOURCE,
      now,
      delayMs: 0,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(matched[0]?.lookup.chargedCents).toBe(10);
    expect(matched[1]?.lookup.chargedCents).toBe(40);
  });
});

describe('reconcileStopHookUsageCosts', () => {
  it('does not call the usage API until the delay has elapsed', async () => {
    const fetchEvents = vi.fn(async () => events);
    const apply = vi.fn(async () => undefined);
    const summary = await reconcileStopHookUsageCosts({
      now: new Date('2026-08-16T12:00:00.000Z'),
      loadPending: async () => [],
      loadCredentials: async () => [
        {
          apiKey: 'team-key-abcdefghijklmnopqrst',
          baseUrl: 'https://api.cursor.com',
          source: 'db',
          label: 'Acme',
        },
      ],
      fetchEvents,
      apply,
    });
    expect(summary.pending).toBe(0);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('writes team usage cost onto delayed pending hooks', async () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const applied: Array<{ id: string; cents: number | null }> = [];
    const summary = await reconcileStopHookUsageCosts({
      now,
      loadPending: async () => [
        {
          id: 'hook-1',
          userEmail: 'a@example.com',
          model: 'gpt-5',
          receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
          finishedAt: null,
        },
      ],
      loadCredentials: async () => [
        {
          apiKey: 'team-key-abcdefghijklmnopqrst',
          baseUrl: 'https://api.cursor.com',
          source: 'db',
          label: 'Acme',
        },
      ],
      fetchEvents: async () => events,
      loadPricedFingerprints: async () => new Set(),
      apply: async (id, lookup) => {
        applied.push({ id, cents: lookup.chargedCents });
      },
    });
    expect(summary.upgraded).toBe(1);
    expect(applied).toEqual([{ id: 'hook-1', cents: 9.5 }]);
  });

  it('records a configuration error when no team key exists', async () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const applied: Array<{ error: string | null }> = [];
    const summary = await reconcileStopHookUsageCosts({
      now,
      loadPending: async () => [
        {
          id: 'hook-1',
          userEmail: 'a@example.com',
          model: 'gpt-5',
          receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
          finishedAt: null,
        },
      ],
      loadCredentials: async () => [],
      fetchEvents: async () => {
        throw new Error('must not fetch');
      },
      apply: async (_id, lookup) => {
        applied.push({ error: lookup.costLookupError });
      },
    });
    expect(summary.failed).toBe(1);
    expect(applied[0]?.error).toMatch(/No Cursor Team API key/i);
  });
});

describe('fetchAllTeamUsageEvents', () => {
  it('pages through listAllFilteredUsageEvents', async () => {
    const listAllFilteredUsageEvents = vi.fn(async () => ({
      items: events,
      truncated: true,
    }));
    const result = await fetchAllTeamUsageEvents({
      client: { listAllFilteredUsageEvents } as never,
      email: null,
      startDate: 1,
      endDate: 2,
    });
    expect(result.events).toEqual(events);
    expect(result.truncated).toBe(true);
    expect(listAllFilteredUsageEvents).toHaveBeenCalledWith(
      { startDate: 1, endDate: 2 },
      { pageSize: 1000, maxPages: 50 },
    );
  });
});

describe('reconcileStopHookUsageCostsFromFirstHook', () => {
  const cred: TeamCostCredential = {
    apiKey: 'team-key-abcdefghijklmnopqrst',
    baseUrl: 'https://api.cursor.com',
    source: 'db',
    label: 'Acme',
  };

  it('fetches from the first hook through now and prices matching turns', async () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const first = new Date('2026-01-01T00:00:00.000Z');
    const window = { startDate: 0, endDate: 0 };
    const applied: Array<{ id: string; cents: number | null }> = [];
    const summary = await reconcileStopHookUsageCostsFromFirstHook({
      now,
      loadEarliest: async () => first,
      loadUnpriced: async () => [
        {
          id: 'old',
          userEmail: 'a@example.com',
          model: 'gpt-5',
          receivedAt: first,
          finishedAt: null,
        },
        {
          id: 'miss',
          userEmail: 'nobody@example.com',
          model: 'gpt-5',
          receivedAt: first,
          finishedAt: null,
        },
      ],
      loadPricedFingerprints: async () => new Set(),
      loadCredentials: async () => [cred],
      fetchEvents: async (opts) => {
        window.startDate = opts.startDate;
        window.endDate = opts.endDate;
        return [
          {
            timestamp: String(first.getTime()),
            userEmail: 'a@example.com',
            model: 'gpt-5',
            chargedCents: 4,
          },
        ];
      },
      apply: async (id, lookup) => {
        applied.push({ id, cents: lookup.chargedCents });
      },
    });
    expect(window.startDate).toBeLessThanOrEqual(first.getTime());
    expect(window.endDate).toBe(now.getTime());
    expect(summary.upgraded).toBe(1);
    expect(summary.unmatched).toBe(1);
    expect(summary.skippedNoTeamKey).toBe(false);
    expect(applied).toEqual([{ id: 'old', cents: 4 }]);
  });

  it('does not price a hook from another conversation’s usage events', async () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const first = new Date(now.getTime() - 60 * 60 * 1000);
    const applied: string[] = [];
    const summary = await reconcileStopHookUsageCostsFromFirstHook({
      now,
      loadEarliest: async () => first,
      loadHooks: async () => [
        {
          id: 'pending',
          userEmail: 'a@example.com',
          model: 'gpt-5',
          conversationId: 'hook-conv',
          receivedAt: first,
          finishedAt: null,
        },
      ],
      loadCredentials: async () => [cred],
      fetchEvents: async () => [
        {
          timestamp: String(first.getTime()),
          userEmail: 'a@example.com',
          conversationId: 'other-conv',
          model: 'gpt-5',
          chargedCents: 9.5,
        },
      ],
      apply: async (id) => {
        applied.push(id);
      },
    });
    expect(summary.upgraded).toBe(0);
    expect(summary.unmatched).toBe(1);
    expect(applied).toEqual([]);
  });

  it('overwrites a previously guessed cost when conversation events are found', async () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const first = new Date(now.getTime() - 60 * 60 * 1000);
    const conv = 'yesterday-conv';
    const applied: Array<{ id: string; cents: number | null }> = [];
    const summary = await reconcileStopHookUsageCostsFromFirstHook({
      now,
      loadEarliest: async () => first,
      loadHooks: async () => [
        {
          id: 'already-priced-wrong',
          userEmail: 'a@example.com',
          model: 'gpt-5',
          conversationId: conv,
          receivedAt: first,
          finishedAt: first,
        },
      ],
      loadCredentials: async () => [cred],
      fetchEvents: async () => [
        {
          timestamp: String(first.getTime() - 30_000),
          userEmail: 'a@example.com',
          conversationId: conv,
          model: 'gpt-5',
          chargedCents: 21,
        },
        {
          timestamp: String(first.getTime() - 10_000),
          userEmail: 'a@example.com',
          conversationId: conv,
          model: 'claude-4.5-sonnet',
          chargedCents: 37,
        },
      ],
      apply: async (id, lookup) => {
        applied.push({ id, cents: lookup.chargedCents });
      },
    });
    expect(summary.upgraded).toBe(1);
    expect(applied).toEqual([{ id: 'already-priced-wrong', cents: 58 }]);
  });

  it('does not write expired errors onto unmatched historical hooks', async () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const first = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const applied: Array<{ error: string | null; source: string | null }> = [];
    const summary = await reconcileStopHookUsageCostsFromFirstHook({
      now,
      loadEarliest: async () => first,
      loadUnpriced: async () => [
        {
          id: 'old',
          userEmail: 'nobody@example.com',
          model: 'gpt-5',
          receivedAt: first,
          finishedAt: null,
        },
      ],
      loadPricedFingerprints: async () => new Set(),
      loadCredentials: async () => [cred],
      fetchEvents: async () => events,
      apply: async (_id, lookup) => {
        applied.push({
          error: lookup.costLookupError,
          source: lookup.costSource,
        });
      },
    });
    expect(summary.upgraded).toBe(0);
    expect(summary.unmatched).toBe(1);
    expect(applied).toEqual([]);
  });

  it('returns skippedNoTeamKey without writing rows', async () => {
    const applied = vi.fn();
    const summary = await reconcileStopHookUsageCostsFromFirstHook({
      now: new Date('2026-08-16T12:00:00.000Z'),
      loadEarliest: async () => new Date('2026-01-01T00:00:00.000Z'),
      loadUnpriced: async () => [
        {
          id: 'old',
          userEmail: 'a@example.com',
          model: 'gpt-5',
          receivedAt: new Date('2026-01-01T00:00:00.000Z'),
          finishedAt: null,
        },
      ],
      loadPricedFingerprints: async () => new Set(),
      loadCredentials: async () => [],
      fetchEvents: async () => {
        throw new Error('must not fetch');
      },
      apply: applied,
    });
    expect(summary.skippedNoTeamKey).toBe(true);
    expect(applied).not.toHaveBeenCalled();
  });
});

describe('lookupFromUsageEvents', () => {
  it('keeps a warning when the turn has no email', () => {
    const result = lookupFromUsageEvents(events, {
      userEmail: null,
      model: 'composer',
      source: HOOK_COST_TEAM_SOURCE,
    });
    expect(result.chargedCents).toBe(1);
    expect(result.costLookupError).toMatch(/no user email/i);
  });
});
