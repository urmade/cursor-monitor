import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilteredUsageEvent } from '@nexus/cursor-client';
import type { DecryptedCursorOrganisation } from '../cursor-credentials';
import {
  syncAutomationUsageForOrganisation,
  type AgentEnrichment,
} from './sync-usage-events';
import type { ServiceContext } from '../context';

function orgFixture(
  overrides: Partial<DecryptedCursorOrganisation> = {},
): DecryptedCursorOrganisation {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'FDE',
    organizationId: 'org_fde123',
    baseUrl: 'https://api.cursor.com',
    orgApiKey: null,
    orgApiKeyHint: null,
    hasOrgApiKey: false,
    createdByUserId: 'user-1',
    apiKeys: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        cursorOrganisationId: '11111111-1111-4111-8111-111111111111',
        label: 'team',
        keyKind: 'service_account',
        apiKey: 'team-key-abcdefghijklmnopqrst',
        fingerprint: 'fp',
        hint: '…abcd',
        identityLabel: 'sa',
        createdByUserId: 'user-1',
        lastValidatedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('syncAutomationUsageForOrganisation', () => {
  const insertedEvents: unknown[] = [];
  const insertedRuns: unknown[] = [];
  const updatedEvents: unknown[] = [];

  beforeEach(() => {
    insertedEvents.length = 0;
    insertedRuns.length = 0;
    updatedEvents.length = 0;
  });

  function mockCtx(): ServiceContext {
    const insertChain = (bucket: unknown[]) => ({
      values: (v: unknown) => {
        bucket.push(v);
        return {
          onConflictDoUpdate: async () => undefined,
        };
      },
    });
    return {
      db: {
        insert: (table: { [key: symbol]: unknown } | object) => {
          const name = String(
            (table as { [key: string]: unknown }).name ??
              (table as { _: { name?: string } })._?.name ??
              '',
          );
          // drizzle tables expose [Symbol] — detect by calling order via buckets
          if (insertedEvents.length <= insertedRuns.length) {
            return insertChain(insertedEvents);
          }
          return insertChain(insertedRuns);
        },
        // Empty aggregate → sync falls back to in-memory bucket totals for the
        // window (real DB returns sum/count over stored events).
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
        query: {
          automationAgentRuns: {
            findFirst: async () => null,
          },
        },
        update: () => ({
          set: (v: unknown) => ({
            where: async () => {
              updatedEvents.push(v);
            },
          }),
        }),
      },
      orgId: '00000000-0000-7000-8000-000000000001',
      actor: { kind: 'system', reason: 'test' },
      flags: { isEnabled: () => false },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as unknown as ServiceContext;
  }

  it('fetches cloudAgentId:* events and persists repo/cost/duration', async () => {
    const events: FilteredUsageEvent[] = [
      {
        timestamp: String(Date.parse('2026-08-02T07:00:30.000Z')),
        automationId: 'auto-abc',
        cloudAgentId: 'bc-agent-1',
        chargedCents: 12.5,
        model: 'composer-2',
      },
    ];
    const listEvents = vi.fn(async () => ({ items: events, truncated: false }));
    const enrichAgent = vi.fn(
      async (): Promise<AgentEnrichment> => ({
        targetRepo: 'acme/widget',
        durationMs: 42_000,
        agentName: 'Auto run',
        rawAgent: { id: 'bc-agent-1' },
        error: null,
      }),
    );

    const result = await syncAutomationUsageForOrganisation(
      mockCtx(),
      orgFixture(),
      {
        nowMs: Date.parse('2026-08-02T07:02:00.000Z'),
        lookbackMs: 6 * 60 * 1000,
        listEvents: async (client, body) => {
          expect(body.cloudAgentId).toBe('*');
          expect(body.organizationId).toBeUndefined();
          expect(client).toBeTruthy();
          return listEvents();
        },
        enrichAgent,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.source).toBe('teams');
    expect(result.eventsFetched).toBe(1);
    expect(result.eventsUpserted).toBe(1);
    expect(result.agentsUpserted).toBe(1);
    expect(result.sample).toEqual({
      automationId: 'auto-abc',
      cloudAgentId: 'bc-agent-1',
      targetRepo: 'acme/widget',
      chargedCentsTotal: 12.5,
      durationMs: 42_000,
    });
    expect(enrichAgent).toHaveBeenCalledWith(
      expect.anything(),
      'bc-agent-1',
    );
  });

  it('stores Cloud Agent runs without an automationId', async () => {
    const result = await syncAutomationUsageForOrganisation(
      mockCtx(),
      orgFixture(),
      {
        listEvents: async (_client, body) => {
          expect(body.cloudAgentId).toBe('*');
          return {
            items: [
              {
                timestamp: '1750979225854',
                cloudAgentId: 'bc-user-run',
                chargedCents: 4,
                model: 'composer-2',
              },
            ],
            truncated: false,
          };
        },
        enrichAgent: async () => ({
          targetRepo: 'acme/solo',
          durationMs: 1000,
          agentName: 'User cloud agent',
          rawAgent: { id: 'bc-user-run' },
          error: null,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.sample).toMatchObject({
      automationId: null,
      cloudAgentId: 'bc-user-run',
      targetRepo: 'acme/solo',
      chargedCentsTotal: 4,
    });
  });

  it('falls back to organisation Admin when team keys fail', async () => {
    const listEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing scope'))
      .mockResolvedValueOnce({
        items: [
          {
            timestamp: '1750979225854',
            automationId: 'auto-org',
            cloudAgentId: 'bc-9',
            chargedCents: 3,
          },
        ] satisfies FilteredUsageEvent[],
        truncated: false,
      });

    const result = await syncAutomationUsageForOrganisation(
      mockCtx(),
      orgFixture({
        orgApiKey: 'org-admin-key-xxxxxxxxxxxxxxxx',
        hasOrgApiKey: true,
        apiKeys: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            cursorOrganisationId: '11111111-1111-4111-8111-111111111111',
            label: 'team',
            keyKind: 'user',
            apiKey: 'team-key-without-usage-scope',
            fingerprint: 'fp',
            hint: '…',
            identityLabel: null,
            createdByUserId: 'user-1',
            lastValidatedAt: null,
            createdAt: new Date(),
          },
        ],
      }),
      {
        listEvents: async (_client, body) => {
          if (!body.organizationId) {
            return listEvents();
          }
          expect(body.organizationId).toBe('org_fde123');
          expect(body.cloudAgentId).toBe('*');
          return listEvents();
        },
        enrichAgent: async () => ({
          targetRepo: null,
          durationMs: null,
          agentName: null,
          rawAgent: null,
          error: 'skip',
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.source).toBe('organizations');
    expect(result.eventsFetched).toBe(1);
  });
});
