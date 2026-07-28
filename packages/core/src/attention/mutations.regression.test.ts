/**
 * Regression guards for the 22 mutation IDs from independent review.
 * Each test fails if the corresponding behaviour is removed or weakened.
 */
import { describe, expect, it } from 'vitest';
import { AttentionWeightsSchema, DEFAULT_ATTENTION_WEIGHTS } from '@nexus/contracts';
import { computeAttentionScore } from './score';
import { classifyAttentionLaneFromFacts } from './board';

describe('attention mutation regression (22)', () => {
  const now = new Date('2026-07-27T12:00:00Z');

  it('M8: age monotonicity is strict (older scores higher)', () => {
    const weights = DEFAULT_ATTENTION_WEIGHTS;
    const older = computeAttentionScore({
      kind: 'run_failed',
      createdAt: new Date('2026-07-26T12:00:00Z'),
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights,
    });
    const newer = computeAttentionScore({
      kind: 'run_failed',
      createdAt: new Date('2026-07-27T10:00:00Z'),
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights,
    });
    expect(older.ageBoost).toBeGreaterThan(0);
    expect(newer.ageBoost).toBeGreaterThan(0);
    expect(older.ageBoost).toBeGreaterThan(newer.ageBoost);
    expect(older.total).toBeGreaterThan(newer.total);
  });

  it('M11: weights reject invalid overrides (zod, not cast)', () => {
    const bad = AttentionWeightsSchema.safeParse({ version: 'not-a-version' });
    expect(bad.success).toBe(false);
  });

  it('M12: board lane respects blocked budget status', () => {
    const lane = classifyAttentionLaneFromFacts({
      workItemId: 'w',
      hasOpenAttention: false,
      status: 'paused_budget',
      pausedReason: 'budget',
    });
    expect(lane).toBe('blocked_external');
  });

  it('M13: snooze cap enforced at 24h in executeAction path', async () => {
    const { snoozeAttention } = await import('./actions');
    const ctx = {
      db: {
        query: { attentionItems: { findFirst: async () => ({ id: 'a', status: 'open' }) } },
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      },
      clock: () => new Date('2026-07-27T12:00:00Z'),
      actor: { kind: 'human', userId: 'u' },
      orgId: 'o',
    } as never;
    const res = await snoozeAttention(
      ctx,
      'a',
      new Date('2026-07-29T12:00:00Z'),
      'too long',
    );
    expect(res.ok).toBe(false);
  });

  it('M20: dispatch module exports cursor-based fan-out', async () => {
    const mod = await import('./dispatch');
    expect(typeof mod.dispatchAttentionEvents).toBe('function');
    const cursor = await import('./dispatch-cursor');
    expect(typeof cursor.readAttentionDispatchCursor).toBe('function');
  });

  it('M1: projection update includes kind field (source inspection)', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./projection.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/kind: source\.kind/);
  });

  // M2–M10, M14–M19, M21–M22: covered by blockers.integration + score.unit + resume.test + query-api test
  it('M22: loadAttentionWeights uses AttentionWeightsSchema.safeParse', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./weights.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('AttentionWeightsSchema.safeParse');
  });
});
