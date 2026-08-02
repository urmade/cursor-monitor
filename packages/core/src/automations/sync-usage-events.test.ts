import { describe, expect, it, vi } from 'vitest';
import type { CursorClient } from '@nexus/cursor-client';
import {
  enrichAgentWithAvailableKeys,
  eventFingerprint,
  primaryRepoLabel,
  wallClockDurationMs,
  __testing,
} from './sync-usage-events';

describe('automation usage sync helpers', () => {
  it('fingerprints events stably and distinctly', () => {
    const a = eventFingerprint('org-row', {
      timestamp: '1000',
      automationId: 'auto-1',
      cloudAgentId: 'bc-1',
      chargedCents: 1.5,
      model: 'composer',
    });
    const b = eventFingerprint('org-row', {
      timestamp: '1000',
      automationId: 'auto-1',
      cloudAgentId: 'bc-1',
      chargedCents: 1.5,
      model: 'composer',
    });
    const c = eventFingerprint('org-row', {
      timestamp: '1000',
      automationId: 'auto-1',
      cloudAgentId: 'bc-1',
      chargedCents: 2.5,
      model: 'composer',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(40);
  });

  it('extracts primary repo labels from agent repos', () => {
    expect(
      primaryRepoLabel([
        { url: 'https://github.com/Acme/Widget.git' },
        { url: 'https://github.com/Acme/Other' },
      ]),
    ).toBe('acme/widget');
    expect(primaryRepoLabel([])).toBeNull();
  });

  it('computes wall-clock duration for terminal runs', () => {
    const ms = wallClockDurationMs(
      {
        status: 'FINISHED',
        createdAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T10:05:00.000Z',
      },
      Date.parse('2026-08-02T12:00:00.000Z'),
    );
    expect(ms).toBe(5 * 60 * 1000);
  });

  it('matches FDE / ADM organisation labels as whole tokens', () => {
    expect(__testing.labelMatches('FDE Europe', ['FDE', 'ADM'])).toBe(true);
    expect(__testing.labelMatches('Cursor ADM', ['FDE', 'ADM'])).toBe(true);
    expect(__testing.labelMatches('Admin Ops', ['FDE', 'ADM'])).toBe(false);
    expect(__testing.labelMatches('fde', ['FDE'])).toBe(true);
  });

  it('parses epoch-ms and iso timestamps', () => {
    const a = __testing.parseEventTimestamp('1750979225854');
    expect(a?.getTime()).toBe(1750979225854);
    const b = __testing.parseEventTimestamp('2026-08-02T07:00:00.000Z');
    expect(b?.toISOString()).toBe('2026-08-02T07:00:00.000Z');
  });

  it('enriches with the first Cloud Agents key that can see the agent', async () => {
    const enrich = vi
      .fn()
      .mockResolvedValueOnce({
        targetRepo: null,
        durationMs: null,
        agentName: null,
        rawAgent: null,
        error: 'not found',
      })
      .mockResolvedValueOnce({
        targetRepo: 'acme/app',
        durationMs: 9000,
        agentName: 'Run',
        rawAgent: { id: 'bc-1' },
        error: null,
      });

    const result = await enrichAgentWithAvailableKeys(
      [{}, {}] as CursorClient[],
      'bc-1',
      enrich,
    );

    expect(result).toMatchObject({
      targetRepo: 'acme/app',
      durationMs: 9000,
      error: null,
    });
    expect(enrich).toHaveBeenCalledTimes(2);
  });
});
