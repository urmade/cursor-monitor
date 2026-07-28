import { describe, expect, it } from 'vitest';
import {
  empiricalQuantile,
  trimOutliers,
  selectComparables,
  buildColdStartEstimate,
  buildRangeEstimate,
  MIN_N_TIER_1_2,
  MIN_N_TIER_3,
  sortBigints,
  type ComparableItem,
} from './math';
import { evaluateWalkForward, interpretBacktest } from './backtest';

function item(
  partial: Partial<ComparableItem> & Pick<ComparableItem, 'id' | 'spendMicroUsd'>,
): ComparableItem {
  return {
    projectId: 'proj-a',
    complexity: 'high',
    spendSource: 'estimated',
    labelKeys: ['risk:high'],
    pipelineFingerprint: 'backlog|ready|deploy',
    completedAt: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

describe('empiricalQuantile', () => {
  it('returns exact values at known points', () => {
    const sorted = sortBigints([10n, 20n, 30n, 40n, 50n]);
    expect(empiricalQuantile(sorted, 0)).toBe(10n);
    expect(empiricalQuantile(sorted, 1)).toBe(50n);
    expect(empiricalQuantile(sorted, 0.5)).toBe(30n);
  });

  it('interpolates between ranks', () => {
    const sorted = [0n, 100n];
    expect(empiricalQuantile(sorted, 0.25)).toBe(25n);
    expect(empiricalQuantile(sorted, 0.75)).toBe(75n);
  });
});

describe('trimOutliers', () => {
  it('drops values beyond 3× IQR', () => {
    const values = [10n, 11n, 12n, 13n, 14n, 1000n];
    const trimmed = trimOutliers(values);
    expect(trimmed).not.toContain(1000n);
    expect(trimmed.length).toBe(5);
  });

  it('uses a 3× fence — not a 300× fence that would keep mild outliers (M3)', () => {
    // Spread cluster [10..20] with a mild outlier at 50.
    // 3×IQR drops 50; 300×IQR would keep it.
    const values = [10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n, 18n, 19n, 20n, 50n];
    const trimmed = trimOutliers(values);
    expect(trimmed).not.toContain(50n);
  });

  it('keeps small samples intact', () => {
    expect(trimOutliers([1n, 2n, 3n])).toEqual([1n, 2n, 3n]);
  });
});

describe('selectComparables', () => {
  const pool: ComparableItem[] = [];
  for (let i = 0; i < 6; i++) {
    pool.push(
      item({
        id: `a-${i}`,
        spendMicroUsd: BigInt(10_000_000 + i * 1_000_000),
        labelKeys: ['risk:high'],
        completedAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
      }),
    );
  }
  // three items only in project B
  for (let i = 0; i < 3; i++) {
    pool.push(
      item({
        id: `b-${i}`,
        projectId: 'proj-b',
        spendMicroUsd: BigInt(5_000_000),
        labelKeys: [],
        completedAt: new Date(`2026-02-0${i + 1}T00:00:00Z`),
      }),
    );
  }

  it('uses tier 1 when same project+complexity+label meets min n', () => {
    const sel = selectComparables(pool, {
      projectId: 'proj-a',
      complexity: 'high',
      labelKeys: ['risk:high'],
      pipelineFingerprint: 'backlog|ready|deploy',
    });
    expect(sel.tier).toBe(1);
    expect(sel.items.length).toBeGreaterThanOrEqual(MIN_N_TIER_1_2);
  });

  it('returns cold start when only three items exist', () => {
    const tiny: ComparableItem[] = [];
    for (let i = 0; i < 3; i++) {
      tiny.push(
        item({
          id: `only-${i}`,
          projectId: 'proj-lonely',
          spendMicroUsd: BigInt(5_000_000),
          labelKeys: [],
          pipelineFingerprint: 'unique|lonely|pipeline',
          completedAt: new Date(`2026-02-0${i + 1}T00:00:00Z`),
        }),
      );
    }
    const sel = selectComparables(tiny, {
      projectId: 'proj-lonely',
      complexity: 'high',
      labelKeys: [],
      pipelineFingerprint: 'unique|lonely|pipeline',
    });
    expect(sel.tier).toBe(4);
    expect(sel.items.length).toBe(3);
  });

  it('requires MIN_N_TIER_3 (=8) before returning tier 3 (M6)', () => {
    expect(MIN_N_TIER_3).toBe(8);
    const pool: ComparableItem[] = [];
    for (let i = 0; i < 7; i++) {
      pool.push(
        item({
          id: `t3-${i}`,
          projectId: 'other',
          spendMicroUsd: BigInt(5_000_000),
          labelKeys: [],
          pipelineFingerprint: 'shared|shape',
          completedAt: new Date(`2026-03-0${(i % 9) + 1}T00:00:00Z`),
        }),
      );
    }
    const sel = selectComparables(pool, {
      projectId: 'target',
      complexity: 'high',
      labelKeys: [],
      pipelineFingerprint: 'shared|shape',
    });
    // 7 org-wide matches is below 8 → cold start, not tier 3
    expect(sel.tier).toBe(4);
    expect(sel.nextThreshold).toBe(MIN_N_TIER_3);
  });

  it('respects walk-forward before filter', () => {
    const sel = selectComparables(pool, {
      projectId: 'proj-a',
      complexity: 'high',
      labelKeys: ['risk:high'],
      pipelineFingerprint: 'backlog|ready|deploy',
      before: new Date('2026-01-03T00:00:00Z'),
    });
    expect(sel.items.every((i) => i.completedAt < new Date('2026-01-03T00:00:00Z'))).toBe(
      true,
    );
    expect(sel.tier).toBe(4);
  });
});

describe('buildColdStartEstimate', () => {
  it('explains itself and never invents a range', () => {
    const est = buildColdStartEstimate({
      n: 2,
      complexity: 'high',
      defaultBudgetMicroUsd: 50_000_000n,
      projectName: 'ACME',
    });
    expect(est.kind).toBe('cold_start');
    if (est.kind !== 'cold_start') return;
    expect(est.basis).toMatch(/only 2 comparable/i);
    expect(est.basis).toMatch(/\$50/);
    expect(est.defaultBudgetMicroUsd).toBe('50000000');
  });

  it('states the tier threshold actually in play (B3)', () => {
    const est = buildColdStartEstimate({
      n: 7,
      complexity: 'high',
      defaultBudgetMicroUsd: 50_000_000n,
      projectName: 'ACME',
      rangeAppearsAfter: 8,
    });
    expect(est.basis).toMatch(/only 7 comparable/i);
    expect(est.basis).toMatch(/after 8/);
    expect(est.basis).not.toMatch(/after 5/);
  });

  it('uses flag_disabled reason when estimates are off', () => {
    const est = buildColdStartEstimate({
      n: 0,
      complexity: 'high',
      defaultBudgetMicroUsd: 50_000_000n,
      projectName: 'ACME',
      reason: 'flag_disabled',
    });
    expect(est.kind).toBe('cold_start');
    if (est.kind !== 'cold_start') return;
    expect(est.reason).toBe('flag_disabled');
    expect(est.basis).toMatch(/disabled/i);
  });
});

describe('buildRangeEstimate', () => {
  it('states basis with n and source mix', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item({
        id: `x-${i}`,
        spendMicroUsd: BigInt((i + 1) * 1_000_000),
        spendSource: i < 3 ? 'provider' : 'estimated',
      }),
    );
    const est = buildRangeEstimate({
      tier: 2,
      items,
      projectName: 'ACME',
      complexity: 'high',
    });
    expect(est.kind).toBe('range');
    if (est.kind !== 'range') return;
    expect(est.n).toBeGreaterThanOrEqual(5);
    expect(est.basis).toMatch(/ACME/);
    expect(est.sourceMix).toBe('mixed');
    expect(BigInt(est.lowMicroUsd)).toBeLessThanOrEqual(BigInt(est.p50MicroUsd));
    expect(BigInt(est.p50MicroUsd)).toBeLessThanOrEqual(BigInt(est.p90MicroUsd));
    // M10: p90 must not collapse onto p50 for a spread sample
    expect(BigInt(est.p90MicroUsd)).toBeGreaterThan(BigInt(est.p50MicroUsd));
  });

  it('does not claim tier-3 items are in the project', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item({
        id: `t3-${i}`,
        projectId: i < 5 ? 'proj-a' : 'proj-b',
        spendMicroUsd: BigInt((i + 1) * 1_000_000),
      }),
    );
    const est = buildRangeEstimate({
      tier: 3,
      items,
      projectName: 'ACME',
      complexity: 'high',
    });
    expect(est.kind).toBe('range');
    if (est.kind !== 'range') return;
    expect(est.basis).toMatch(/organisation|pipeline/i);
    expect(est.basis).not.toMatch(/in ACME/);
  });
});

describe('evaluateWalkForward', () => {
  it('reports poor coverage when intervals are too narrow', () => {
    const rows = Array.from({ length: 20 }, () => ({
      actualMicro: BigInt(100_000_000),
      complexity: 'high' as const,
      estimate: {
        kind: 'range' as const,
        tier: 2 as const,
        n: 10,
        p50MicroUsd: '10000000',
        p90MicroUsd: '12000000',
        lowMicroUsd: '8000000',
        basis: 'test',
        computedAt: new Date().toISOString(),
        sourceMix: 'estimated' as const,
      },
    }));
    const result = evaluateWalkForward(rows);
    expect(result.coverage).toBe(0);
    expect(result.interpretation).toMatch(/too narrow/i);
    // M13: bias must reflect actual/p50 (=10), not a hardcoded 1.0
    expect(result.p50Bias).toBe(10);
    // M12: MAPE must not be hardcoded 0
    expect(result.mape).toBeGreaterThan(0);
  });

  it('recovers ~80% coverage on a calibrated synthetic distribution', () => {
    // Actuals drawn uniformly from [10, 90]; intervals [10,90] → full coverage.
    const rows = Array.from({ length: 40 }, (_, i) => {
      const actual = BigInt(10_000_000 + i * 2_000_000);
      return {
        actualMicro: actual,
        complexity: (i % 2 === 0 ? 'high' : 'medium') as 'high' | 'medium',
        estimate: {
          kind: 'range' as const,
          tier: 2 as const,
          n: 20,
          lowMicroUsd: '10000000',
          p50MicroUsd: '50000000',
          p90MicroUsd: '90000000',
          basis: 'synth',
          computedAt: new Date().toISOString(),
          sourceMix: 'estimated' as const,
        },
      };
    });
    const result = evaluateWalkForward(rows);
    expect(result.coverage).toBeGreaterThan(0.7);
    expect(result.sampleSize).toBe(40);
  });

  it('skips cold_start rows (they are not scored as ranges)', () => {
    const result = evaluateWalkForward([
      {
        actualMicro: 1_000_000n,
        complexity: 'low',
        estimate: buildColdStartEstimate({
          n: 1,
          complexity: 'low',
          defaultBudgetMicroUsd: 5_000_000n,
          projectName: 'X',
        }),
      },
    ]);
    expect(result.sampleSize).toBe(0);
    expect(result.interpretation).toMatch(/never evaluated|undefined/i);
  });

  it('MAPE is normalised by actual (not forecast)', () => {
    const result = evaluateWalkForward([
      {
        actualMicro: 1_000_000n,
        complexity: 'high',
        estimate: {
          kind: 'range',
          tier: 2,
          n: 5,
          p50MicroUsd: '1000000000',
          p90MicroUsd: '1100000000',
          lowMicroUsd: '900000000',
          basis: 'test',
          computedAt: new Date().toISOString(),
          sourceMix: 'estimated',
        },
      },
    ]);
    // |1e6 - 1e9| / 1e6 ≈ 999 — must not cap at ~1.0 via forecast normalisation.
    expect(result.mape).toBeGreaterThan(100);
  });
});

describe('interpretBacktest', () => {
  it('calls out low coverage honestly', () => {
    expect(interpretBacktest(0.4, 1.0)).toMatch(/too narrow/i);
  });

  it('does not recommend widening when the failure is over-prediction', () => {
    const text = interpretBacktest(0.5, 0.5);
    expect(text).toMatch(/over-prediction|run high/i);
  });

  it('explains empty samples instead of claiming 0% coverage', () => {
    expect(interpretBacktest(0, null, 0)).toMatch(/never evaluated/i);
  });
});
