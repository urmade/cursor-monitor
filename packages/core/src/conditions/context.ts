import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  labels,
  projects,
  runs,
  stageReports,
  stages,
  workItemLabels,
  workItems,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import type { GateContext } from './evaluate';

/**
 * Build an immutable gate evaluation context for one work item.
 * Fetched once per evaluateGates batch so every gate sees the same facts.
 */
export async function buildGateContext(
  ctx: ServiceContext,
  workItemId: string,
  opts?: {
    prospectiveReturn?: { fromStageId: string; toStageId: string };
  },
): Promise<GateContext | null> {
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, workItemId), isNull(workItems.archivedAt)),
  });
  if (!item) return null;

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  if (!project) return null;

  const stage = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, item.currentStageId),
  });

  const labelRows = await ctx.db
    .select({ key: labels.key })
    .from(workItemLabels)
    .innerJoin(labels, eq(labels.id, workItemLabels.labelId))
    .where(eq(workItemLabels.workItemId, workItemId));

  let acceptanceCriteriaCount = 0;
  let specExists = false;
  if (item.currentSpecVersionId) {
    const { specVersions } = await import('@nexus/db');
    const spec = await ctx.db.query.specVersions.findFirst({
      where: eq(specVersions.id, item.currentSpecVersionId),
    });
    if (spec) {
      specExists = true;
      const content = spec.content as Record<string, unknown>;
      const ac = content.acceptanceCriteria;
      acceptanceCriteriaCount = Array.isArray(ac) ? ac.length : 0;
    }
  }

  const latestReport = await ctx.db.query.stageReports.findFirst({
    where: eq(stageReports.workItemId, workItemId),
    orderBy: [desc(stageReports.createdAt)],
  });

  const activeRun = item.currentRunId
    ? await ctx.db.query.runs.findFirst({ where: eq(runs.id, item.currentRunId) })
    : null;

  let countInStage = 0;
  if (item.currentStageInstanceId) {
    const rows = await ctx.db
      .select({ c: sql<number>`count(*)::int` })
      .from(runs)
      .where(eq(runs.stageInstanceId, item.currentStageInstanceId));
    countInStage = Number(rows[0]?.c ?? 0);
  }

  // Warnings table may not exist until migration 0010 — guard via try/dynamic.
  let openCount = 0;
  let openInCurrentStageCount = 0;
  let openCodes: string[] = [];
  try {
    const { warnings } = await import('@nexus/db');
    const open = await ctx.db.query.warnings.findMany({
      where: and(eq(warnings.workItemId, workItemId), eq(warnings.status, 'open')),
    });
    openCount = open.length;
    openCodes = open.map((w) => w.code);
    if (item.currentStageInstanceId) {
      openInCurrentStageCount = open.filter(
        (w) => w.originStageInstanceId === item.currentStageInstanceId,
      ).length;
    }
  } catch {
    // Schema not yet loaded in test without migration — leave zeros.
  }

  const settings = (project.settings ?? {}) as Record<string, unknown>;
  const enforcementMode =
    settings.enforcement_mode === 'observe' ? 'observe' : 'enforce';

  let itemSpentRatio: number | null = null;
  let projectSpentRatio: number | null = null;
  try {
    const { budgetsFeatureEnabled } = await import('../budgets/flags');
    if (await budgetsFeatureEnabled(ctx, project.id)) {
      const { computeBudgetState } = await import('../budgets/state');
      const budget = await computeBudgetState(ctx, workItemId);
      if (budget) {
        itemSpentRatio = budget.item.ratio;
        projectSpentRatio = budget.project.ratio;
      }
    }
  } catch {
    // schema / flags optional in early tests
  }

  const reportBody = latestReport?.raw as Record<string, unknown> | undefined;

  let loopCount = 0;
  let countFromStage = 0;
  let edges: Array<{ fromStageId: string; toStageId: string }> = [];
  const prospectiveReturn = opts?.prospectiveReturn ?? null;
  try {
    loopCount = item.loopCount ?? 0;
    const { loopEdges } = await import('@nexus/db');
    const edgeRows = await ctx.db
      .select({
        fromStageId: loopEdges.fromStageId,
        toStageId: loopEdges.toStageId,
      })
      .from(loopEdges)
      .where(eq(loopEdges.workItemId, workItemId));
    edges = edgeRows;
    if (item.currentStageId) {
      countFromStage = edges.filter(
        (e) => e.fromStageId === item.currentStageId,
      ).length;
      if (prospectiveReturn) countFromStage += 1;
    }
  } catch (e) {
    // Fail closed when loops are expected — do not silently zero counts.
    const loopsOn = await ctx.flags
      .isEnabled('p5.loops', item.projectId)
      .catch(() => false);
    if (loopsOn) {
      throw e instanceof Error
        ? e
        : new Error(`Failed to load loop edges: ${String(e)}`);
    }
  }

  const prospectiveCount = prospectiveReturn ? loopCount + 1 : loopCount;

  return {
    ticket: {
      id: item.id,
      projectId: item.projectId,
      title: item.title,
      complexity: item.complexity,
      ownerClass: item.ownerClass,
      stageKey: stage?.key ?? null,
      stageId: stage?.id ?? null,
      currentStageInstanceId: item.currentStageInstanceId,
    },
    labels: labelRows.map((r) => r.key),
    spec: {
      exists: specExists,
      acceptanceCriteriaCount,
    },
    latestReport: latestReport
      ? {
          outcome: latestReport.outcome ?? (reportBody?.outcome as string) ?? null,
          confidence:
            latestReport.confidence != null
              ? Number(latestReport.confidence)
              : typeof reportBody?.confidence === 'number'
                ? reportBody.confidence
                : null,
          notVerifiedCount: Array.isArray(latestReport.notVerified)
            ? latestReport.notVerified.length
            : Array.isArray(reportBody?.not_verified)
              ? (reportBody.not_verified as unknown[]).length
              : 0,
          assumptionsCount: Array.isArray(latestReport.assumptions)
            ? latestReport.assumptions.length
            : Array.isArray(reportBody?.assumptions)
              ? (reportBody.assumptions as unknown[]).length
              : 0,
        }
      : null,
    activeRun: {
      status: activeRun?.status ?? null,
      countInStage,
    },
    warnings: {
      openCount,
      openInCurrentStageCount,
      openCodes,
    },
    loops: {
      count: prospectiveCount,
      itemLoopCount: loopCount,
      countFromStage,
      prospectiveCount,
      edges,
      prospectiveReturn,
    },
    budget: {
      itemSpentRatio,
      projectSpentRatio,
    },
    project: {
      id: project.id,
      key: project.key,
      enforcementMode,
    },
  };
}

/** Build a synthetic context for unit tests — no DB. */
export function emptyGateContext(
  overrides: Partial<GateContext> = {},
): GateContext {
  const base: GateContext = {
    ticket: {
      id: '00000000-0000-7000-8000-000000000001',
      projectId: '00000000-0000-7000-8000-000000000002',
      title: 'Test',
      complexity: null,
      ownerClass: 'human',
      stageKey: null,
      stageId: '00000000-0000-7000-8000-000000000003',
      currentStageInstanceId: null,
    },
    labels: [],
    spec: { exists: false, acceptanceCriteriaCount: 0 },
    latestReport: null,
    activeRun: { status: null, countInStage: 0 },
    warnings: { openCount: 0, openInCurrentStageCount: 0, openCodes: [] },
    loops: { count: 0, countFromStage: 0 },
    budget: { itemSpentRatio: null, projectSpentRatio: null },
    project: {
      id: '00000000-0000-7000-8000-000000000002',
      key: 'TEST',
      enforcementMode: 'enforce',
    },
  };
  return {
    ...base,
    ...overrides,
    ticket: { ...base.ticket, ...(overrides.ticket ?? {}) },
    spec: { ...base.spec, ...(overrides.spec ?? {}) },
    activeRun: { ...base.activeRun, ...(overrides.activeRun ?? {}) },
    warnings: { ...base.warnings, ...(overrides.warnings ?? {}) },
    loops: { ...base.loops, ...(overrides.loops ?? {}) },
    budget: { ...base.budget, ...(overrides.budget ?? {}) },
    project: { ...base.project, ...(overrides.project ?? {}) },
    latestReport:
      overrides.latestReport === undefined
        ? base.latestReport
        : overrides.latestReport,
    labels: overrides.labels ?? base.labels,
  };
}
