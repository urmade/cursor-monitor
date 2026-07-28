import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { StatusFacts } from '@nexus/contracts';
import { ACTIVE_RUN_STATUSES } from '@nexus/contracts';
import { questions, runs, statusOverrides, workItems } from '@nexus/db';
import type { ServiceContext } from '../context';
import { deriveStatus } from '../status/derive';

export async function loadStatusFacts(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Partial<StatusFacts>> {
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
  const recent = await ctx.db.query.runs.findMany({
    where: eq(runs.workItemId, workItemId),
    orderBy: [desc(runs.createdAt)],
    limit: 20,
  });
  let failedRunsSinceLastSuccess = 0;
  for (const r of recent) {
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

  return {
    activeRuns: activeRuns.length,
    openBlockingQuestions: openBlocking.length,
    failedRunsSinceLastSuccess,
    override: override
      ? {
          status: override.status as import('@nexus/contracts').DerivedStatus,
          reason: override.reason,
        }
      : null,
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

export async function countMcpCallsLastMinute(
  ctx: ServiceContext,
): Promise<number> {
  const { mcpCallLog } = await import('@nexus/db');
  const rows = await ctx.db.execute(sql`
    select count(*)::int as c from mcp_call_log
    where created_at > now() - interval '1 minute'
  `);
  const arr = rows as unknown as Array<{ c: number }>;
  return Number(arr[0]?.c ?? 0);
}
