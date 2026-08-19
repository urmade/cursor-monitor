import { describe, expect, it, vi } from 'vitest';
import { createDatabaseAdapterStub } from '@cursor-monitor/db/testing';
import { listCompleteWindow, syncTeamUsage } from './team-sync';

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
});
