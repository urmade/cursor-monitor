import { describe, expect, it } from 'vitest';
import { deriveStatus } from './derive';

describe('deriveStatus', () => {
  const active = { archivedAt: null, externallyBlockedReason: null };

  it('returns archived when archivedAt is set', () => {
    expect(
      deriveStatus({ archivedAt: new Date(), externallyBlockedReason: null }),
    ).toBe('archived');
  });

  it('honours override over other facts', () => {
    expect(
      deriveStatus(active, {
        override: { status: 'abandoned', reason: 'duplicate' },
        activeRuns: 2,
      }),
    ).toBe('abandoned');
  });

  it('returns blocked_external from item flag', () => {
    expect(
      deriveStatus({
        archivedAt: null,
        externallyBlockedReason: 'waiting on vendor',
      }),
    ).toBe('blocked_external');
  });

  it('returns paused_budget when budget blocked', () => {
    expect(deriveStatus(active, { budgetState: 'blocked' })).toBe(
      'paused_budget',
    );
  });

  it('returns needs_answer when blocking questions open', () => {
    expect(deriveStatus(active, { openBlockingQuestions: 1 })).toBe(
      'needs_answer',
    );
  });

  it('returns needs_approval for pending approvals', () => {
    expect(deriveStatus(active, { pendingApprovals: 1 })).toBe('needs_approval');
  });

  it('returns blocked_by_gate for blocking gate results without approvals', () => {
    expect(deriveStatus(active, { blockingGateResults: 1 })).toBe(
      'blocked_by_gate',
    );
  });

  it('prefers needs_approval over blocked_by_gate when both set', () => {
    expect(
      deriveStatus(active, { pendingApprovals: 1, blockingGateResults: 2 }),
    ).toBe('needs_approval');
  });

  it('returns failed_run when failures and no active runs', () => {
    expect(
      deriveStatus(active, {
        failedRunsSinceLastSuccess: 1,
        activeRuns: 0,
      }),
    ).toBe('failed_run');
  });

  it('returns ai_working when active runs', () => {
    expect(deriveStatus(active, { activeRuns: 1 })).toBe('ai_working');
  });

  it('returns idle by default in Phase 1', () => {
    expect(deriveStatus(active)).toBe('idle');
  });
});
