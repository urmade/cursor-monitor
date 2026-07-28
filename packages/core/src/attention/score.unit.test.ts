import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_WEIGHTS } from '@nexus/contracts';
import { computeAttentionScore } from './score';

describe('attention score', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  const created = new Date('2026-07-27T06:00:00Z');

  it('ranks blocking questions above approvals', () => {
    const q = computeAttentionScore({
      kind: 'blocking_question',
      createdAt: created,
      complexity: 'medium',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const a = computeAttentionScore({
      kind: 'pending_approval',
      createdAt: created,
      complexity: 'medium',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(q.total).toBeGreaterThan(a.total);
  });

  it('older identical items score higher (age monotonicity)', () => {
    const older = computeAttentionScore({
      kind: 'run_failed',
      createdAt: new Date('2026-07-26T12:00:00Z'),
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const newer = computeAttentionScore({
      kind: 'run_failed',
      createdAt: new Date('2026-07-27T10:00:00Z'),
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(older.total).toBeGreaterThan(newer.total);
  });

  it('snooze lowers score', () => {
    const base = computeAttentionScore({
      kind: 'budget_block',
      createdAt: created,
      complexity: 'high',
      spentMicroUsd: BigInt(10_000_000),
      loopCount: 2,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const snoozed = computeAttentionScore({
      kind: 'budget_block',
      createdAt: created,
      complexity: 'high',
      spentMicroUsd: BigInt(10_000_000),
      loopCount: 2,
      snoozedUntil: new Date('2026-07-27T18:00:00Z'),
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(snoozed.total).toBeLessThan(base.total);
  });
});
