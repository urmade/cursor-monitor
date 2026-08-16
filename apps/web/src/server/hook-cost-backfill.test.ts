import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireSession, backfill, checkRateLimit } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  backfill: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('./session', () => ({
  requireSession: (...args: unknown[]) => requireSession(...args),
}));

vi.mock('@nexus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexus/core')>();
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
    reconcileStopHookUsageCostsFromFirstHook: (...args: unknown[]) =>
      backfill(...args),
  };
});

const { actionBackfillStopHookCosts } = await import('./hook-cost-backfill');
const { revalidatePath } = await import('next/cache');

function sessionStub() {
  return {
    user: { externalSub: 'sub', rawClaims: {} },
    userId: 'user-1',
    orgId: 'nexus-org-1',
    ctx: {
      orgId: 'nexus-org-1',
      actor: { kind: 'human' as const, userId: 'user-1' },
      db: {},
      clock: () => new Date('2026-01-01T00:00:00Z'),
      flags: { enabled: async () => false },
    },
  };
}

describe('actionBackfillStopHookCosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSession.mockResolvedValue(sessionStub());
    checkRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 0,
      retryAfterSec: 0,
    });
    backfill.mockResolvedValue({
      fromReceivedAt: '2026-01-01T00:00:00.000Z',
      pending: 2,
      upgraded: 1,
      unmatched: 1,
      failed: 0,
      usageEvents: 10,
      usageTruncated: false,
      pendingTruncated: false,
      credentials: 1,
      skippedNoHooks: false,
      skippedNoTeamKey: false,
    });
  });

  it('requires a session and rate-limits to one run per minute', async () => {
    const result = await actionBackfillStopHookCosts();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.summary.upgraded).toBe(1);
    expect(requireSession).toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith(
      'cursor-hook-cost-backfill:user-1',
      1,
    );
    expect(backfill).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith('/monitoring');
  });

  it('rejects when the rate limit is exceeded', async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSec: 42,
    });
    const result = await actionBackfillStopHookCosts();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/42 seconds/);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('surfaces a missing Team API key without claiming success', async () => {
    backfill.mockResolvedValue({
      fromReceivedAt: '2026-01-01T00:00:00.000Z',
      pending: 2,
      upgraded: 0,
      unmatched: 2,
      failed: 0,
      usageEvents: 0,
      usageTruncated: false,
      pendingTruncated: false,
      credentials: 0,
      skippedNoHooks: false,
      skippedNoTeamKey: true,
      message: 'No Cursor Team API key configured',
    });
    const result = await actionBackfillStopHookCosts();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/Team API key/);
  });
});
