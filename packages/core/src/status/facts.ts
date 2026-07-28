import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { StatusFacts } from '@nexus/contracts';
import { ACTIVE_RUN_STATUSES } from '@nexus/contracts';
import {
  questions,
  runs,
  stageInstances,
  statusOverrides,
  workItems,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import { deriveStatus } from '../status/derive';

export async function loadStatusFacts(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Partial<StatusFacts>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });

  const activeRuns = await ctx.db.query.runs.findMany({
    where: and(
      eq(runs.workItemId, workItemId),
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
    ),
  });

  const openBlocking = await ctx.db.query.questions.findMany({
    where: and(
      eq(questions.workItemId, workItemId),
      eq(questions.status, 'open'),
      eq(questions.blocking, true),
    ),
  });

  // Failed runs since last success (completed with report).
  const recentRuns = await ctx.db.query.runs.findMany({
    where: eq(runs.workItemId, workItemId),
    orderBy: [desc(runs.createdAt)],
    limit: 20,
  });
  let failedRunsSinceLastSuccess = 0;
  for (const r of recentRuns) {
    if (r.status === 'completed') break;
    if (
      r.status === 'failed' ||
      r.status === 'completed_no_report' ||
      r.status === 'launch_failed' ||
      r.status === 'expired'
    ) {
      failedRunsSinceLastSuccess += 1;
    }
  }

  const override = await ctx.db.query.statusOverrides.findFirst({
    where: and(
      eq(statusOverrides.workItemId, workItemId),
      isNull(statusOverrides.clearedAt),
    ),
    orderBy: [desc(statusOverrides.createdAt)],
  });

  let pendingApprovals = 0;
  let blockingGateResults = 0;
  try {
    const { approvals, gateEvaluations, gates } = await import('@nexus/db');
    const pending = await ctx.db.query.approvals.findMany({
      where: and(
        eq(approvals.workItemId, workItemId),
        eq(approvals.status, 'pending'),
      ),
    });
    pendingApprovals = pending.length;

    // Only evaluations at/after the current stage instance matter. A successful
    // transition (including override) creates a new instance, clearing old blocks.
    let enteredAt: Date | null = null;
    if (item?.currentStageInstanceId) {
      const si = await ctx.db.query.stageInstances.findFirst({
        where: eq(stageInstances.id, item.currentStageInstanceId),
      });
      enteredAt = si?.enteredAt ?? null;
    }

    const evalWhere = enteredAt
      ? and(
          eq(gateEvaluations.workItemId, workItemId),
          gte(gateEvaluations.createdAt, enteredAt),
        )
      : eq(gateEvaluations.workItemId, workItemId);

    const recent = await ctx.db.query.gateEvaluations.findMany({
      where: evalWhere,
      orderBy: [desc(gateEvaluations.createdAt)],
      limit: 50,
    });
    const seen = new Set<string>();
    const blockingGateIds: string[] = [];
    for (const ev of recent) {
      if (seen.has(ev.gateId)) continue;
      seen.add(ev.gateId);
      if (ev.outcome === 'block' || ev.outcome === 'error') {
        blockingGateIds.push(ev.gateId);
      }
    }
    if (blockingGateIds.length) {
      const gateRows = await ctx.db.query.gates.findMany({
        where: inArray(gates.id, blockingGateIds),
      });
      blockingGateResults = gateRows.filter(
        (g) =>
          g.evaluator !== 'human_approval' &&
          g.enabled &&
          g.archivedAt == null,
      ).length;
    }
  } catch {
    // tables may be absent in very early tests
  }

  let budgetState: 'ok' | 'warn' | 'blocked' = 'ok';
  try {
    const itemRow = await ctx.db.query.workItems.findFirst({
      where: eq(workItems.id, workItemId),
    });
    const { budgetsFeatureEnabled } = await import('../budgets/flags');
    if (
      itemRow &&
      (await budgetsFeatureEnabled(ctx, itemRow.projectId))
    ) {
      if (itemRow.pausedReason === 'budget') {
        budgetState = 'blocked';
      } else {
        const { computeBudgetState } = await import('../budgets/state');
        const st = await computeBudgetState(ctx, workItemId);
        if (st) {
          if (st.item.state === 'blocked' || st.project.state === 'blocked') {
            budgetState = 'blocked';
          } else if (st.item.state === 'warn' || st.project.state === 'warn') {
            budgetState = 'warn';
          }
        }
      }
    }
  } catch {
    budgetState = 'ok';
  }

  return {
    activeRuns: activeRuns.length,
    openBlockingQuestions: openBlocking.length,
    failedRunsSinceLastSuccess,
    pendingApprovals,
    blockingGateResults,
    override: override
      ? {
          status: override.status as import('@nexus/contracts').DerivedStatus,
          reason: override.reason,
        }
      : null,
    budgetState,
    loopEscalated: item?.loopEscalated ?? false,
  };
}

export async function deriveWorkItemStatus(
  ctx: ServiceContext,
  workItemId: string,
) {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return null;
  const facts = await loadStatusFacts(ctx, workItemId);
  return deriveStatus(
    {
      archivedAt: item.archivedAt,
      externallyBlockedReason: item.externallyBlockedReason,
    },
    facts,
  );
}

/** Batch helper for board cards. */
export async function loadActiveRunElapsed(
  ctx: ServiceContext,
  workItemIds: string[],
): Promise<Map<string, { runId: string; startedAt: Date; status: string }>> {
  const map = new Map<string, { runId: string; startedAt: Date; status: string }>();
  if (workItemIds.length === 0) return map;
  const rows = await ctx.db.query.runs.findMany({
    where: and(
      inArray(runs.workItemId, workItemIds),
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
    ),
  });
  for (const r of rows) {
    map.set(r.workItemId, {
      runId: r.id,
      startedAt: r.startedAt ?? r.launchedAt ?? r.createdAt,
      status: r.status,
    });
  }
  return map;
}

/** Batched status facts for board swimlanes (bounded query count). */
export async function loadStatusFactsForWorkItems(
  ctx: ServiceContext,
  items: Array<{
    id: string;
    pausedReason: string | null;
    loopEscalated: boolean;
    currentStageInstanceId: string | null;
  }>,
): Promise<Map<string, Partial<StatusFacts>>> {
  const map = new Map<string, Partial<StatusFacts>>();
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return map;

  const empty = (): Partial<StatusFacts> => ({
    activeRuns: 0,
    openBlockingQuestions: 0,
    failedRunsSinceLastSuccess: 0,
    pendingApprovals: 0,
    blockingGateResults: 0,
    override: null,
    budgetState: 'ok',
    loopEscalated: false,
  });
  for (const id of ids) map.set(id, empty());

  const activeRuns = await ctx.db.query.runs.findMany({
    where: and(
      inArray(runs.workItemId, ids),
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
    ),
  });
  for (const r of activeRuns) {
    const f = map.get(r.workItemId)!;
    f.activeRuns = (f.activeRuns ?? 0) + 1;
  }

  const openBlocking = await ctx.db.query.questions.findMany({
    where: and(
      inArray(questions.workItemId, ids),
      eq(questions.status, 'open'),
      eq(questions.blocking, true),
    ),
  });
  for (const q of openBlocking) {
    const f = map.get(q.workItemId)!;
    f.openBlockingQuestions = (f.openBlockingQuestions ?? 0) + 1;
  }

  const overrides = await ctx.db.query.statusOverrides.findMany({
    where: and(inArray(statusOverrides.workItemId, ids), isNull(statusOverrides.clearedAt)),
    orderBy: [desc(statusOverrides.createdAt)],
  });
  const seenOverride = new Set<string>();
  for (const o of overrides) {
    if (seenOverride.has(o.workItemId)) continue;
    seenOverride.add(o.workItemId);
    const f = map.get(o.workItemId)!;
    f.override = {
      status: o.status as import('@nexus/contracts').DerivedStatus,
      reason: o.reason,
    };
  }

  try {
    const { approvals } = await import('@nexus/db');
    const pending = await ctx.db.query.approvals.findMany({
      where: and(inArray(approvals.workItemId, ids), eq(approvals.status, 'pending')),
    });
    for (const a of pending) {
      const f = map.get(a.workItemId)!;
      f.pendingApprovals = (f.pendingApprovals ?? 0) + 1;
    }
  } catch {
    // gates package optional in early tests
  }

  for (const item of items) {
    const f = map.get(item.id)!;
    f.loopEscalated = item.loopEscalated;
    if (item.pausedReason === 'budget') {
      f.budgetState = 'blocked';
    }
  }

  return map;
}

export async function countMcpCallsLastMinute(
  ctx: ServiceContext,
): Promise<number> {
  const rows = await ctx.db.execute(sql`
    select count(*)::int as c from mcp_call_log
    where created_at > now() - interval '1 minute'
  `);
  const arr = rows as unknown as Array<{ c: number }>;
  return Number(arr[0]?.c ?? 0);
}
