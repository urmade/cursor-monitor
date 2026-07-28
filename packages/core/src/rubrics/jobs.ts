import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { gates, pendingEvaluations, rubricVerdicts } from '@nexus/db';
import type { ServiceContext } from '../context';
import { evaluateGates } from '../gates/evaluate';
import { evaluateRubric } from './evaluate';

const STALE_RUNNING_MS = 5 * 60 * 1000;

/**
 * Reclaim pending_evaluations stuck in `running` longer than the TTL so a
 * crashed worker cannot wedge the item behind the partial unique index.
 */
export async function reclaimStaleRunningEvaluations(
  ctx: ServiceContext,
  olderThanMs = STALE_RUNNING_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = await ctx.db
    .update(pendingEvaluations)
    .set({
      status: 'pending',
      errorDetail: 'reclaimed_stale_running',
    })
    .where(
      and(
        eq(pendingEvaluations.status, 'running'),
        lt(pendingEvaluations.createdAt, cutoff),
      ),
    )
    .returning({ id: pendingEvaluations.id });
  return stale.length;
}

/**
 * Claim and complete pending async agentic evaluations.
 * Called from cron so core stays free of a jobs dependency cycle.
 */
export async function processPendingEvaluations(
  ctx: ServiceContext,
  limit = 10,
): Promise<{ processed: number; failed: number; reclaimed: number }> {
  const reclaimed = await reclaimStaleRunningEvaluations(ctx);

  const pending = await ctx.db.query.pendingEvaluations.findMany({
    where: inArray(pendingEvaluations.status, ['pending']),
    limit,
  });

  let processed = 0;
  let failed = 0;

  for (const row of pending) {
    const claimed = await ctx.db
      .update(pendingEvaluations)
      .set({ status: 'running' })
      .where(
        and(
          eq(pendingEvaluations.id, row.id),
          eq(pendingEvaluations.status, 'pending'),
        ),
      )
      .returning({ id: pendingEvaluations.id });
    if (claimed.length === 0) continue;

    const gate = await ctx.db.query.gates.findFirst({
      where: eq(gates.id, row.gateId),
    });
    const rubricId =
      gate && typeof gate.config?.rubricId === 'string'
        ? gate.config.rubricId
        : null;

    if (!rubricId) {
      await ctx.db
        .update(pendingEvaluations)
        .set({
          status: 'failed',
          errorDetail: 'gate missing rubricId',
          completedAt: new Date(),
        })
        .where(eq(pendingEvaluations.id, row.id));
      failed += 1;
      continue;
    }

    const result = await evaluateRubric(ctx, {
      rubricId,
      workItemId: row.workItemId,
      skipAuthz: true,
    });

    if (!result.ok) {
      await ctx.db
        .update(pendingEvaluations)
        .set({
          status: 'failed',
          errorDetail: result.error.message,
          completedAt: new Date(),
        })
        .where(eq(pendingEvaluations.id, row.id));
      failed += 1;
      continue;
    }

    await ctx.db
      .update(pendingEvaluations)
      .set({
        status: 'completed',
        verdictId: result.value.stored.id,
        completedAt: new Date(),
      })
      .where(eq(pendingEvaluations.id, row.id));

    await evaluateGates(ctx, {
      workItemId: row.workItemId,
      trigger: (row.trigger as { kind: 'on_demand' }) ?? { kind: 'on_demand' },
    });
    processed += 1;
  }

  return { processed, failed, reclaimed };
}

/** Retention: strip raw_response older than N days (criteria retained). */
export async function scrubOldRawResponses(
  ctx: ServiceContext,
  olderThanDays = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await ctx.db
    .update(rubricVerdicts)
    .set({ rawResponse: null })
    .where(
      and(
        lt(rubricVerdicts.createdAt, cutoff),
        sql`${rubricVerdicts.rawResponse} is not null`,
      ),
    )
    .returning({ id: rubricVerdicts.id });
  return result.length;
}
