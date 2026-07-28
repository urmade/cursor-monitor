import { and, desc, eq, isNull } from 'drizzle-orm';
import { BacktestBreakdownSchema, type BacktestResult, type Complexity, type CostEstimate } from '@nexus/contracts';
import { estimateBacktests, newId, projects } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { estimateForNewItem, loadComparablePool } from './estimate';
import { labelKeysFromPoolItem } from './helpers';

export type BacktestBreakdown = {
  n: number;
  coverage: number;
  p50Bias: number | null;
  mape: number | null;
};

/** Fits numeric(14,3). */
const NUMERIC_14_3_MAX = Number('9999999999999.999');

export function clampNumeric14_3(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n > NUMERIC_14_3_MAX) return NUMERIC_14_3_MAX;
  if (n < -NUMERIC_14_3_MAX) return -NUMERIC_14_3_MAX;
  return n;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** MAPE normalised by actual: mean(|actual − p50| / |actual|). */
function mapeOf(p50s: number[], actuals: number[]): number | null {
  if (p50s.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < p50s.length; i++) {
    const a = actuals[i]!;
    if (a === 0) continue;
    sum += Math.abs(a - p50s[i]!) / Math.abs(a);
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

function breakdown(
  rows: Array<{ actual: number; p50: number; low: number; high: number }>,
): BacktestBreakdown {
  if (rows.length === 0) {
    return { n: 0, coverage: 0, p50Bias: null, mape: null };
  }
  const inside = rows.filter((r) => r.actual >= r.low && r.actual <= r.high).length;
  const coverage = inside / rows.length;
  const withP50 = rows.filter((r) => r.p50 > 0);
  const ratios = withP50.map((r) => r.actual / r.p50);
  const actuals = withP50.map((r) => r.actual);
  const p50s = withP50.map((r) => r.p50);
  return {
    n: rows.length,
    coverage,
    p50Bias: median(ratios),
    mape: mapeOf(p50s, actuals),
  };
}

export function interpretBacktest(
  coverage: number,
  p50Bias: number | null,
  sampleSize = 1,
): string {
  if (sampleSize === 0) {
    return 'No ranged estimates were scored — the estimator was never evaluated on this history (every item was cold-start). Coverage is undefined, not 0%.';
  }
  const parts: string[] = [];
  if (coverage < 0.65) {
    parts.push(
      `Intervals are too narrow: ${(coverage * 100).toFixed(0)}% coverage against a target of ~80%. Consider widening the interval or raising the minimum comparable count.`,
    );
  } else if (coverage > 0.92) {
    parts.push(
      `Intervals may be too wide: ${(coverage * 100).toFixed(0)}% coverage (target ~80%). Ranges are conservative.`,
    );
  } else {
    parts.push(
      `Coverage is ${(coverage * 100).toFixed(0)}% — near the ~80% target for a p10–p90 interval.`,
    );
  }
  if (p50Bias != null) {
    if (p50Bias < 0.85) {
      parts.push(
        `p50 bias ${p50Bias.toFixed(2)} suggests estimates run high (actuals below p50). Widening intervals will not fix systematic over-prediction — investigate the price table or comparable mix.`,
      );
    } else if (p50Bias > 1.15) {
      parts.push(
        `p50 bias ${p50Bias.toFixed(2)} suggests estimates run low (actuals above p50).`,
      );
    } else {
      parts.push(`p50 bias ${p50Bias.toFixed(2)} is near 1.0 (well calibrated).`);
    }
  }
  return parts.join(' ');
}

export function evaluateWalkForward(
  rows: Array<{
    actualMicro: bigint;
    estimate: CostEstimate;
    complexity: Complexity;
  }>,
): {
  sampleSize: number;
  coverage: number;
  p50Bias: number | null;
  mape: number | null;
  byComplexity: Record<string, BacktestBreakdown>;
  byTier: Record<string, BacktestBreakdown>;
  interpretation: string;
} {
  const scored: Array<{
    actual: number;
    p50: number;
    low: number;
    high: number;
    complexity: Complexity;
    tier: string;
  }> = [];

  for (const row of rows) {
    if (row.estimate.kind !== 'range') continue;
    scored.push({
      actual: Number(row.actualMicro),
      p50: Number(row.estimate.p50MicroUsd),
      low: Number(row.estimate.lowMicroUsd),
      high: Number(row.estimate.p90MicroUsd),
      complexity: row.complexity,
      tier: String(row.estimate.tier),
    });
  }

  const overall = breakdown(scored);
  const byComplexity: Record<string, BacktestBreakdown> = {};
  for (const c of ['low', 'medium', 'high'] as Complexity[]) {
    byComplexity[c] = breakdown(scored.filter((r) => r.complexity === c));
  }
  const byTier: Record<string, BacktestBreakdown> = {};
  for (const t of ['1', '2', '3']) {
    byTier[t] = breakdown(scored.filter((r) => r.tier === t));
  }

  return {
    sampleSize: scored.length,
    coverage: overall.coverage,
    p50Bias: overall.p50Bias,
    mape: overall.mape,
    byComplexity,
    byTier,
    interpretation: interpretBacktest(
      overall.coverage,
      overall.p50Bias,
      scored.length,
    ),
  };
}

export async function runBacktest(
  ctx: ServiceContext,
  opts: { projectId?: string } = {},
): Promise<Result<BacktestResult, CoreError>> {
  if (opts.projectId) {
    const project = await ctx.db.query.projects.findFirst({
      where: and(
        eq(projects.id, opts.projectId),
        eq(projects.orgId, ctx.orgId),
        isNull(projects.archivedAt),
      ),
    });
    if (!project) return err(coreError('not_found', 'Project not found'));

    const role = await getProjectRole(ctx, opts.projectId);
    if (
      !can(ctx.actor, 'project.read', {
        type: 'project',
        projectId: opts.projectId,
        role,
      })
    ) {
      return err(coreError('not_found', 'Project not found'));
    }
  } else if (ctx.actor.kind !== 'system' && ctx.actor.kind !== 'human') {
    return err(coreError('forbidden', 'Cannot run organisation backtest'));
  }

  const pool = await loadComparablePool(ctx, {
    orgId: ctx.orgId,
    projectId: opts.projectId,
  });

  const completed = opts.projectId
    ? pool.filter((i) => i.projectId === opts.projectId)
    : pool;

  completed.sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());

  const rows: Array<{
    actualMicro: bigint;
    estimate: CostEstimate;
    complexity: Complexity;
  }> = [];

  for (const item of completed) {
    const est = await estimateForNewItem(ctx, {
      projectId: item.projectId,
      complexity: item.complexity,
      labelKeys: labelKeysFromPoolItem(item),
      asOf: item.completedAt,
      bypassCache: true,
    });
    if (!est.ok) continue;
    rows.push({
      actualMicro: item.spendMicroUsd,
      estimate: est.value,
      complexity: item.complexity,
    });
  }

  const evaluated = evaluateWalkForward(rows);
  const id = newId();
  const ranAt = new Date();

  const p50BiasClamped =
    evaluated.p50Bias != null ? clampNumeric14_3(evaluated.p50Bias) : 0;
  const mapeClamped =
    evaluated.mape != null ? clampNumeric14_3(evaluated.mape) : 0;

  try {
    await ctx.db.insert(estimateBacktests).values({
      id,
      orgId: ctx.orgId,
      projectId: opts.projectId ?? null,
      ranAt,
      sampleSize: evaluated.sampleSize,
      coverage: clampNumeric14_3(evaluated.coverage).toFixed(3),
      p50Bias: p50BiasClamped.toFixed(3),
      mape: mapeClamped.toFixed(3),
      byComplexity: evaluated.byComplexity,
      byTier: evaluated.byTier,
      detail: {
        coldStartSkipped: completed.length - evaluated.sampleSize,
        scored: evaluated.sampleSize,
      },
      interpretation: evaluated.interpretation,
    });
  } catch (e) {
    return err(
      coreError(
        'invariant',
        e instanceof Error ? e.message : 'Failed to persist backtest',
      ),
    );
  }

  return ok({
    id,
    projectId: opts.projectId ?? null,
    ranAt: ranAt.toISOString(),
    sampleSize: evaluated.sampleSize,
    coverage: evaluated.coverage,
    p50Bias: evaluated.p50Bias,
    mape: evaluated.mape,
    byComplexity: evaluated.byComplexity,
    byTier: evaluated.byTier,
    interpretation: evaluated.interpretation,
  });
}

export async function latestBacktest(
  ctx: ServiceContext,
  opts: { projectId?: string } = {},
): Promise<Result<BacktestResult | null, CoreError>> {
  if (opts.projectId) {
    const project = await ctx.db.query.projects.findFirst({
      where: and(
        eq(projects.id, opts.projectId),
        eq(projects.orgId, ctx.orgId),
      ),
    });
    if (!project) return err(coreError('not_found', 'Project not found'));

    const role = await getProjectRole(ctx, opts.projectId);
    if (
      !can(ctx.actor, 'project.read', {
        type: 'project',
        projectId: opts.projectId,
        role,
      })
    ) {
      return err(coreError('not_found', 'Project not found'));
    }
  }

  const row = await ctx.db.query.estimateBacktests.findFirst({
    where: opts.projectId
      ? and(
          eq(estimateBacktests.projectId, opts.projectId),
          eq(estimateBacktests.orgId, ctx.orgId),
        )
      : and(
          eq(estimateBacktests.orgId, ctx.orgId),
          isNull(estimateBacktests.projectId),
        ),
    orderBy: [desc(estimateBacktests.ranAt)],
  });
  if (!row) return ok(null);

  return ok({
    id: row.id,
    projectId: row.projectId,
    ranAt: row.ranAt.toISOString(),
    sampleSize: row.sampleSize,
    coverage: Number(row.coverage),
    p50Bias: Number(row.p50Bias),
    mape: Number(row.mape),
    byComplexity: zRecordBreakdown(row.byComplexity),
    byTier: zRecordBreakdown(row.byTier),
    interpretation: row.interpretation,
  });
}

function zRecordBreakdown(raw: unknown): BacktestResult['byComplexity'] {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const out: BacktestResult['byComplexity'] = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = BacktestBreakdownSchema.parse(v);
  }
  return out;
}
