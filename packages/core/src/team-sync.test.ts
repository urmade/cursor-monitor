import { describe, expect, it, vi } from 'vitest';
import { listCompleteWindow } from './team-sync';

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
