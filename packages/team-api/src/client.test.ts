import { describe, expect, it, vi } from 'vitest';
import { credentialsFromEnv, TeamApiClient } from './client';
import { stableJson, usageConversationKey, usageEventFingerprint } from './fingerprint';

describe('TeamApiClient', () => {
  it('pages organization usage events until exhausted', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            usageEvents: [{ timestamp: '2026-01-01', conversationId: 'A' }],
            pagination: { hasNextPage: true },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            usageEvents: [{ timestamp: '2026-01-02', conversationId: 'B' }],
            pagination: { hasNextPage: false },
          }),
          { status: 200 },
        ),
      );
    const client = new TeamApiClient({
      credentials: {
        kind: 'organization',
        apiKey: 'test-key',
        organizationId: 'org-1',
      },
      fetchImpl,
    });

    const result = await client.listUsageEvents({
      startDate: 1,
      endDate: 2,
    });

    expect(result).toMatchObject({ pages: 2, truncated: false });
    expect(result.events).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.cursor.com/organizations/filtered-usage-events',
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      organizationId: 'org-1',
      page: 1,
    });
  });
});

describe('usage identity', () => {
  it('fingerprints objects independent of property order', () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(
      usageEventFingerprint({ timestamp: 'x', conversationId: 'A', z: 1 }),
    ).toBe(
      usageEventFingerprint({ z: 1, conversationId: 'A', timestamp: 'x' }),
    );
  });

  it('normalizes conversation ids and prefers organization credentials', () => {
    expect(usageConversationKey({ timestamp: 'x', conversationId: ' AbC ' })).toBe(
      'abc',
    );
    expect(
      credentialsFromEnv({
        CURSOR_ORGANIZATION_API_KEY: 'org-key',
        CURSOR_ORGANIZATION_ID: 'org-id',
        CURSOR_TEAM_API_KEY: 'team-key',
      }),
    ).toMatchObject({ kind: 'organization', apiKey: 'org-key' });
  });
});
