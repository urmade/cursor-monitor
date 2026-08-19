import { describe, expect, it, vi } from 'vitest';
import { createDatabaseAdapterStub } from '@cursor-monitor/db/testing';
import {
  listCompleteWindow,
  listCompleteWindowForCredentials,
  syncTeamUsage,
} from './team-sync';

describe('complete Team API windows', () => {
  it('bisects a truncated window and combines complete halves', async () => {
    const listUsageEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ timestamp: 'ignored' }],
        pages: 20,
        truncated: true,
      })
      .mockResolvedValueOnce({
        events: [{ timestamp: 'older' }],
        pages: 1,
        truncated: false,
      })
      .mockResolvedValueOnce({
        events: [{ timestamp: 'newer' }],
        pages: 1,
        truncated: false,
      });

    const result = await listCompleteWindow(
      { listUsageEvents },
      0,
      60 * 60 * 1000,
      Date.now() + 10_000,
    );

    expect(result).toEqual({
      events: [{ timestamp: 'older' }, { timestamp: 'newer' }],
      pages: 2,
      truncated: false,
    });
    expect(listUsageEvents).toHaveBeenCalledTimes(3);
  });
});

describe('Team usage persistence adapter', () => {
  it('persists a successful sync through semantic adapter operations', async () => {
    const insertRun = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => undefined);
    const releaseLease = vi.fn(async () => undefined);
    const insertDeduplicated = vi.fn(async () => 1);
    const database = createDatabaseAdapterStub({
      usage: { insertDeduplicated },
      sync: {
        latestSuccessfulWindowEnd: async () => null,
        insertRun,
        updateRun,
        tryAcquireLease: async () => true,
        releaseLease,
      },
    });
    const now = new Date('2026-08-19T00:00:00.000Z');
    const listUsageEvents = vi.fn().mockResolvedValue({
      events: [
        {
          timestamp: '2026-08-18T23:59:00.000Z',
          conversationId: 'conversation-1',
          chargedCents: 2.5,
        },
      ],
      pages: 1,
      truncated: false,
    });

    const result = await syncTeamUsage({
      database,
      now,
      env: { CURSOR_TEAM_API_KEY: 'team-test-key' },
      client: { listUsageEvents },
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      fetched: 1,
      inserted: 1,
    });
    expect(insertRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running' }),
    );
    expect(insertDeduplicated).toHaveBeenCalledOnce();
    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'succeeded', insertedCount: 1 }),
    );
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('fetches usage from every configured team key', async () => {
    const insertRun = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => undefined);
    const releaseLease = vi.fn(async () => undefined);
    const insertDeduplicated = vi.fn(
      async (events: readonly unknown[]) => events.length,
    );
    const database = createDatabaseAdapterStub({
      usage: { insertDeduplicated },
      sync: {
        latestSuccessfulWindowEnd: async () => null,
        insertRun,
        updateRun,
        tryAcquireLease: async () => true,
        releaseLease,
      },
    });
    const now = new Date('2026-08-19T00:00:00.000Z');
    const listUsageEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [
          {
            timestamp: '2026-08-18T23:59:00.000Z',
            conversationId: 'conversation-1',
          },
        ],
        pages: 1,
        truncated: false,
      })
      .mockResolvedValueOnce({
        events: [
          {
            timestamp: '2026-08-18T23:58:00.000Z',
            conversationId: 'conversation-2',
          },
        ],
        pages: 1,
        truncated: false,
      });

    const result = await syncTeamUsage({
      database,
      now,
      env: { CURSOR_TEAM_API_KEYS: 'team-a,team-b' },
      createClient: (credentials) => ({
        listUsageEvents: vi.fn().mockImplementation(async () => {
          if (credentials.kind !== 'team') {
            throw new Error('expected team credential');
          }
          return listUsageEvents();
        }),
      }),
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      fetched: 2,
      inserted: 2,
    });
    expect(listUsageEvents).toHaveBeenCalledTimes(2);
    expect(insertDeduplicated).toHaveBeenCalledOnce();
  });

  it('continues when one team key fails and another succeeds', async () => {
    const result = await listCompleteWindowForCredentials(
      [
        { kind: 'team', apiKey: 'bad-key' },
        { kind: 'team', apiKey: 'good-key' },
      ],
      0,
      60_000,
      Date.now() + 10_000,
      {
        createClient: (credentials) => ({
          listUsageEvents: vi.fn(async () => {
            if (credentials.kind === 'team' && credentials.apiKey === 'bad-key') {
              throw new Error('401 unauthorized');
            }
            return {
              events: [{ timestamp: '2026-01-01', conversationId: 'ok' }],
              pages: 1,
              truncated: false,
            };
          }),
        }),
      },
    );

    expect(result).toMatchObject({
      events: [{ conversationId: 'ok' }],
      pages: 1,
      truncated: false,
    });
  });
});
