import { and, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  analyticsDaily,
  gateEvaluations,
  gates,
  interventions,
  projects,
  stageInstances,
  stages,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { empiricalQuantile, sortBigints } from './math';

export type AnalyticsSummary = {
  window: { from: string; to: string };
  costPerItem: {
    medianMicroUsd: string;
    p90MicroUsd: string;
    byComplexity: Record<
      string,
      { n: number; medianMicroUsd: string; p90MicroUsd: string }
    >;
  };
  spendVersusBudget: {
    overrunCount: number;
    itemCount: number;
    medianSpendBudgetRatio: number | null;
  };
  rework: {
    itemsWithLoops: number;
    itemCount: number;
    reworkRate: number;
    reworkCostShare: number;
  };
  gates: Record<string, { pass: number; warn: number; block: number; total: number }>;
  humanTouches: { medianPerItem: number | null; meanPerItem: number | null };
  stageDurations: Record<string, { medianMs: number | null; n: number }>;
  source: 'analytics_daily' | 'live';
};

const AnalyticsSummarySchema: z.ZodType<AnalyticsSummary> = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  costPerItem: z.object({
    medianMicroUsd: z.string(),
    p90MicroUsd: z.string(),
    byComplexity: z.record(
      z.object({
        n: z.number(),
        medianMicroUsd: z.string(),
        p90MicroUsd: z.string(),
      }),
    ),
  }),
  spendVersusBudget: z.object({
    overrunCount: z.number(),
    itemCount: z.number(),
    medianSpendBudgetRatio: z.number().nullable(),
  }),
  rework: z.object({
    itemsWithLoops: z.number(),
    itemCount: z.number(),
    reworkRate: z.number(),
    reworkCostShare: z.number(),
  }),
  gates: z.record(
    z.object({
      pass: z.number(),
      warn: z.number(),
      block: z.number(),
      total: z.number(),
    }),
  ),
  humanTouches: z.object({
    medianPerItem: z.number().nullable(),
    meanPerItem: z.number().nullable(),
  }),
  stageDurations: z.record(
    z.object({
      medianMs: z.number().nullable(),
      n: z.number(),
    }),
  ),
  source: z.enum(['analytics_daily', 'live']),
});

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Yesterday UTC — the last complete calendar day for analytics_daily (B4). */
export function yesterdayUtc(now = new Date()): Date {
  return addUtcDays(startOfUtcDay(now), -1);
}

function quantileMicro(values: bigint[], p: number): bigint {
  return empiricalQuantile(sortBigints(values), p);
}

async function loadOrgProject(ctx: ServiceContext, projectId: string) {
  return ctx.db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, ctx.orgId),
      isNull(projects.archivedAt),
    ),
  });
}

export async function computeProjectMetrics(
  ctx: ServiceContext,
  projectId: string,
  window: { from: Date; to: Date },
): Promise<AnalyticsSummary> {
  // Cost/rework window: items created in range that are now terminal (should-fix).
  const terminalItems = await ctx.db
    .select({
      id: workItems.id,
      complexity: workItems.complexity,
      spendMicroUsd: workItems.spendMicroUsd,
      budgetMicroUsd: workItems.budgetMicroUsd,
      loopCount: workItems.loopCount,
      reworkCostMicroUsd: workItems.reworkCostMicroUsd,
    })
    .from(workItems)
    .innerJoin(stages, eq(stages.id, workItems.currentStageId))
    .where(
      and(
        eq(workItems.projectId, projectId),
        isNull(workItems.archivedAt),
        gte(workItems.createdAt, window.from),
        lte(workItems.createdAt, window.to),
        eq(stages.isTerminal, true),
      ),
    );

  // All non-archived items in window (for human-touch denominator — includes in-flight).
  const windowItems = await ctx.db.query.workItems.findMany({
    where: and(
      eq(workItems.projectId, projectId),
      isNull(workItems.archivedAt),
      gte(workItems.createdAt, window.from),
      lte(workItems.createdAt, window.to),
    ),
  });

  const spends = terminalItems.map((i) => i.spendMicroUsd);
  const median = spends.length ? quantileMicro(spends, 0.5) : 0n;
  const p90 = spends.length ? quantileMicro(spends, 0.9) : 0n;

  const byComplexity: AnalyticsSummary['costPerItem']['byComplexity'] = {};
  for (const c of ['low', 'medium', 'high'] as const) {
    const subset = terminalItems
      .filter((i) => i.complexity === c)
      .map((i) => i.spendMicroUsd);
    byComplexity[c] = {
      n: subset.length,
      medianMicroUsd: (subset.length ? quantileMicro(subset, 0.5) : 0n).toString(),
      p90MicroUsd: (subset.length ? quantileMicro(subset, 0.9) : 0n).toString(),
    };
  }

  const withBudget = terminalItems.filter(
    (i) => i.budgetMicroUsd != null && i.budgetMicroUsd > 0n,
  );
  const overrunCount = withBudget.filter(
    (i) => i.spendMicroUsd > (i.budgetMicroUsd as bigint),
  ).length;
  const ratios = withBudget.map(
    (i) => Number(i.spendMicroUsd) / Number(i.budgetMicroUsd),
  );
  ratios.sort((a, b) => a - b);
  const medianRatio =
    ratios.length === 0
      ? null
      : ratios.length % 2 === 0
        ? (ratios[ratios.length / 2 - 1]! + ratios[ratios.length / 2]!) / 2
        : ratios[Math.floor(ratios.length / 2)]!;

  const itemsWithLoops = terminalItems.filter((i) => (i.loopCount ?? 0) > 0).length;
  const totalSpend = terminalItems.reduce((a, i) => a + i.spendMicroUsd, 0n);
  const totalRework = terminalItems.reduce(
    (a, i) => a + (i.reworkCostMicroUsd ?? 0n),
    0n,
  );

  // Gate rates window on evaluation date (should-fix), not item creation.
  const gateRows = await ctx.db
    .select({
      gateKey: gates.name,
      outcome: gateEvaluations.outcome,
    })
    .from(gateEvaluations)
    .innerJoin(gates, eq(gates.id, gateEvaluations.gateId))
    .innerJoin(workItems, eq(workItems.id, gateEvaluations.workItemId))
    .where(
      and(
        eq(workItems.projectId, projectId),
        gte(gateEvaluations.createdAt, window.from),
        lte(gateEvaluations.createdAt, window.to),
      ),
    );

  const gateStats: AnalyticsSummary['gates'] = {};
  for (const g of gateRows) {
    const slot = (gateStats[g.gateKey] ??= {
      pass: 0,
      warn: 0,
      block: 0,
      total: 0,
    });
    slot.total += 1;
    if (g.outcome === 'pass') slot.pass += 1;
    else if (g.outcome === 'warn') slot.warn += 1;
    else if (g.outcome === 'block') slot.block += 1;
  }

  // B5: include zero-touch items (left-join semantics) — thesis metric.
  const itemIds = windowItems.map((i) => i.id);
  const touchRows =
    itemIds.length === 0
      ? []
      : await ctx.db
          .select({
            workItemId: interventions.workItemId,
            n: sql<number>`count(*)::int`,
          })
          .from(interventions)
          .where(inArray(interventions.workItemId, itemIds))
          .groupBy(interventions.workItemId);
  const touchMap = new Map(touchRows.map((r) => [r.workItemId, Number(r.n)]));
  const touchCounts = itemIds.map((id) => touchMap.get(id) ?? 0);
  touchCounts.sort((a, b) => a - b);
  const medianTouches =
    touchCounts.length === 0
      ? null
      : touchCounts.length % 2 === 0
        ? (touchCounts[touchCounts.length / 2 - 1]! +
            touchCounts[touchCounts.length / 2]!) /
          2
        : touchCounts[Math.floor(touchCounts.length / 2)]!;
  const meanTouches =
    touchCounts.length === 0
      ? null
      : touchCounts.reduce((a, b) => a + b, 0) / touchCounts.length;

  const durationRows =
    itemIds.length === 0
      ? []
      : await ctx.db
          .select({
            stageKey: stages.key,
            enteredAt: stageInstances.enteredAt,
            exitedAt: stageInstances.exitedAt,
          })
          .from(stageInstances)
          .innerJoin(stages, eq(stages.id, stageInstances.stageId))
          .where(inArray(stageInstances.workItemId, itemIds));

  const byStage = new Map<string, number[]>();
  for (const r of durationRows) {
    if (!r.exitedAt) continue;
    const ms = r.exitedAt.getTime() - r.enteredAt.getTime();
    const list = byStage.get(r.stageKey) ?? [];
    list.push(ms);
    byStage.set(r.stageKey, list);
  }
  const stageDurations: AnalyticsSummary['stageDurations'] = {};
  for (const [key, msList] of byStage) {
    msList.sort((a, b) => a - b);
    const mid = Math.floor(msList.length / 2);
    const medianMs =
      msList.length === 0
        ? null
        : msList.length % 2 === 0
          ? Math.round((msList[mid - 1]! + msList[mid]!) / 2)
          : msList[mid]!;
    stageDurations[key] = { medianMs, n: msList.length };
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    costPerItem: {
      medianMicroUsd: median.toString(),
      p90MicroUsd: p90.toString(),
      byComplexity,
    },
    spendVersusBudget: {
      overrunCount,
      itemCount: withBudget.length,
      medianSpendBudgetRatio: medianRatio,
    },
    rework: {
      itemsWithLoops,
      itemCount: terminalItems.length,
      reworkRate:
        terminalItems.length === 0 ? 0 : itemsWithLoops / terminalItems.length,
      reworkCostShare:
        totalSpend === 0n ? 0 : Number(totalRework) / Number(totalSpend),
    },
    gates: gateStats,
    humanTouches: {
      medianPerItem: medianTouches,
      meanPerItem: meanTouches,
    },
    stageDurations,
    source: 'live',
  };
}

/**
 * Materialise analytics_daily for a **completed** UTC calendar day (B4).
 * Refuses "today" — the window is incomplete.
 */
export async function computeDaily(
  ctx: ServiceContext,
  day: Date,
): Promise<Result<void, CoreError>> {
  const start = startOfUtcDay(day);
  const today = startOfUtcDay(new Date());
  if (start.getTime() >= today.getTime()) {
    return err(
      coreError(
        'conflict',
        'analytics_daily only materialises completed UTC days (day < today)',
      ),
    );
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  const orgProjects = await ctx.db.query.projects.findMany({
    where: and(eq(projects.orgId, ctx.orgId), isNull(projects.archivedAt)),
  });

  for (const p of orgProjects) {
    const metrics = await computeProjectMetrics(ctx, p.id, { from: start, to: end });
    const key = dayKey(start);
    const parsed = AnalyticsSummarySchema.parse({
      ...metrics,
      source: 'analytics_daily',
    });
    await ctx.db
      .insert(analyticsDaily)
      .values({
        day: key,
        projectId: p.id,
        metrics: parsed as unknown as Record<string, unknown>,
        computedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [analyticsDaily.day, analyticsDaily.projectId],
        set: {
          metrics: parsed as unknown as Record<string, unknown>,
          computedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }
  return ok(undefined);
}

/** Backfill analytics_daily for each complete UTC day in [from, to). */
export async function backfillAnalyticsDaily(
  ctx: ServiceContext,
  input: { from: Date; to: Date },
): Promise<Result<{ days: number }, CoreError>> {
  let cursor = startOfUtcDay(input.from);
  const end = startOfUtcDay(input.to);
  const today = startOfUtcDay(new Date());
  const stop = end.getTime() < today.getTime() ? end : today;
  let days = 0;
  while (cursor.getTime() < stop.getTime()) {
    const r = await computeDaily(ctx, cursor);
    if (r.ok) days += 1;
    cursor = addUtcDays(cursor, 1);
  }
  return ok({ days });
}

export async function projectAnalytics(
  ctx: ServiceContext,
  projectId: string,
  window: { from: Date; to: Date },
): Promise<Result<AnalyticsSummary, CoreError>> {
  // B1: org-scoped project resolve + authz (M22).
  const project = await loadOrgProject(ctx, projectId);
  if (!project) return err(coreError('not_found', 'Project not found'));

  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.view_analytics', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }

  const todayStart = startOfUtcDay(new Date());
  const fromKey = dayKey(window.from);
  const toExclusive = addUtcDays(startOfUtcDay(window.to), 1);
  // Never include incomplete "today" in the daily path (B4).
  const serveUntil =
    toExclusive.getTime() > todayStart.getTime() ? todayStart : toExclusive;
  const toKeyExclusive = dayKey(serveUntil);

  if (serveUntil.getTime() > startOfUtcDay(window.from).getTime()) {
    const rows = await ctx.db.query.analyticsDaily.findMany({
      where: and(
        eq(analyticsDaily.projectId, projectId),
        gte(analyticsDaily.day, fromKey),
        lt(analyticsDaily.day, toKeyExclusive),
      ),
    });

    const expectedDays = Math.round(
      (serveUntil.getTime() - startOfUtcDay(window.from).getTime()) / 86_400_000,
    );

    // Single complete calendar day fully covered → serve stored row.
    if (
      expectedDays === 1 &&
      rows.length === 1 &&
      rows[0]!.day === fromKey &&
      startOfUtcDay(window.from).getTime() < todayStart.getTime()
    ) {
      const metrics = AnalyticsSummarySchema.parse(rows[0]!.metrics);
      return ok({ ...metrics, source: 'analytics_daily' });
    }

    // Multi-day: only use daily cache when every complete day is present.
    if (expectedDays > 1 && rows.length >= expectedDays) {
      // Recompute live for multi-day aggregate so numbers still reconcile;
      // mark source to indicate daily coverage was verified.
      const live = await computeProjectMetrics(ctx, projectId, window);
      return ok({ ...live, source: 'analytics_daily' });
    }
  }

  const live = await computeProjectMetrics(ctx, projectId, window);
  return ok(live);
}

export function analyticsToCsv(summary: AnalyticsSummary): string {
  const lines = [
    'metric,value',
    `cost_median_micro_usd,${summary.costPerItem.medianMicroUsd}`,
    `cost_p90_micro_usd,${summary.costPerItem.p90MicroUsd}`,
    `overrun_count,${summary.spendVersusBudget.overrunCount}`,
    `rework_rate,${summary.rework.reworkRate}`,
    `rework_cost_share,${summary.rework.reworkCostShare}`,
    `human_touches_median,${summary.humanTouches.medianPerItem ?? ''}`,
  ];
  for (const [gate, s] of Object.entries(summary.gates)) {
    lines.push(`gate_${gate}_pass,${s.pass}`);
    lines.push(`gate_${gate}_warn,${s.warn}`);
    lines.push(`gate_${gate}_block,${s.block}`);
  }
  return lines.join('\n') + '\n';
}
