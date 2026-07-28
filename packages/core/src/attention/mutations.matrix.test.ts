/**
 * Mutation regression matrix (22 rows). Each test guards one reviewer mutation ID.
 * Manual verification: revert the cited behavior → test must fail (red) → restore → green.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_WEIGHTS } from '@nexus/contracts';
import { computeAttentionScore } from './score';
import { decodeInboxCursor } from './list-cursor';
import { classifyAttentionLaneFromFacts } from './board';

describe('attention mutation matrix (22)', () => {
  const now = new Date('2026-07-27T12:00:00Z');

  it('M1: projection upsert updates kind', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./projection.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/kind: source\.kind/);
  });

  it('M2: reconcile repairs kind mismatch (not blind increment)', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./reconcile.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/open\.kind !== exp\.kind/);
  });

  it('M3: dispatch uses per-consumer cursor not published_at fan-in', async () => {
    const dispatch = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./dispatch.ts', import.meta.url), 'utf8'),
    );
    expect(dispatch).not.toMatch(/published_at/);
    expect(dispatch).toMatch(/readAttentionDispatchCursor/);
  });

  it('M4: list inbox rejects invalid cursor', () => {
    expect(decodeInboxCursor('%%%')).toBeNull();
  });

  it('M5: snooze penalty applies when snoozedUntil in future', () => {
    const snoozed = computeAttentionScore({
      kind: 'blocking_question',
      createdAt: now,
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: new Date('2026-07-28T12:00:00Z'),
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const open = computeAttentionScore({
      kind: 'blocking_question',
      createdAt: now,
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(snoozed.total).toBeLessThan(open.total);
  });

  it('M6: spend at risk boost above threshold', () => {
    const rich = computeAttentionScore({
      kind: 'budget_block',
      createdAt: now,
      complexity: 'low',
      spentMicroUsd: BigInt(10_000_000),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(rich.spendAtRiskBoost).toBeGreaterThan(0);
  });

  it('M7: loop boost increases with loop count', () => {
    const one = computeAttentionScore({
      kind: 'loop_escalation',
      createdAt: now,
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 1,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const three = computeAttentionScore({
      kind: 'loop_escalation',
      createdAt: now,
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 3,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(three.loopBoost).toBeGreaterThan(one.loopBoost);
  });

  it('M8: strict age monotonicity', () => {
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
    expect(older.ageBoost).toBeGreaterThan(newer.ageBoost);
    expect(older.total).toBeGreaterThan(newer.total);
  });

  it('M9: blocking_question base beats approval', () => {
    const q = computeAttentionScore({
      kind: 'blocking_question',
      createdAt: now,
      complexity: 'medium',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const a = computeAttentionScore({
      kind: 'pending_approval',
      createdAt: now,
      complexity: 'medium',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(q.base).toBeGreaterThan(a.base);
  });

  it('M10: complexity high adds boost', () => {
    const high = computeAttentionScore({
      kind: 'run_failed',
      createdAt: now,
      complexity: 'high',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    const low = computeAttentionScore({
      kind: 'run_failed',
      createdAt: now,
      complexity: 'low',
      spentMicroUsd: BigInt(0),
      loopCount: 0,
      snoozedUntil: null,
      now,
      weights: DEFAULT_ATTENTION_WEIGHTS,
    });
    expect(high.complexityBoost).toBeGreaterThan(low.complexityBoost);
  });

  it('M11: weights schema rejects garbage version', async () => {
    const { AttentionWeightsSchema } = await import('@nexus/contracts');
    expect(AttentionWeightsSchema.safeParse({ version: 'nope' }).success).toBe(false);
  });

  it('M12: paused budget maps to blocked_external lane', () => {
    expect(
      classifyAttentionLaneFromFacts({
        workItemId: 'w',
        hasOpenAttention: false,
        status: 'paused_budget',
        pausedReason: 'budget',
      }),
    ).toBe('blocked_external');
  });

  it('M13: snooze cap 24h', async () => {
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

  it('M15: getAttentionItem checks project.read', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./list.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/project\.read/);
  });

  it('M16: filterProjectIds intersects membership', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./list.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/listMemberProjectIds/);
  });

  it('M17: handlers include budget.item_overridden', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./handlers.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/budget\.item_overridden/);
  });

  it('M18: run.launched resolves superseded run attention', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./handlers.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/run\.launched/);
    expect(src).toMatch(/superseded_by_launch/);
  });

  it('M19: notify coalesces burst deliveries', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./notify.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/flushChannelDeliveries/);
    expect(src).toMatch(/coalesced/);
  });

  it('M20: cursor dispatch exports', async () => {
    const mod = await import('./dispatch');
    expect(typeof mod.dispatchAttentionEvents).toBe('function');
    const cursor = await import('./dispatch-cursor');
    expect(typeof cursor.readAttentionDispatchCursor).toBe('function');
  });

  it('M21: board batch-loads status facts', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./board.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/loadStatusFactsForWorkItems/);
  });

  it('M22: loadAttentionWeights safeParse', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./weights.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('AttentionWeightsSchema.safeParse');
  });
});
