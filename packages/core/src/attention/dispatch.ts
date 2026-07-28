import { and, asc, eq, gt, or } from 'drizzle-orm';
import { events } from '@nexus/db';
import type { ServiceContext } from '../context';
import { handleAttentionEvent, isAttentionEvent } from './handlers';
import {
  readAttentionDispatchCursor,
  writeAttentionDispatchCursor,
} from './dispatch-cursor';

export type DispatchSummary = {
  processed: number;
  attentionHandled: number;
};

async function dispatchAttentionEventsBatch(
  ctx: ServiceContext,
  limit: number,
): Promise<DispatchSummary> {
  const cursor = await readAttentionDispatchCursor(ctx);

  const conditions = [eq(events.orgId, ctx.orgId)];
  if (cursor) {
    conditions.push(
      or(
        gt(events.occurredAt, new Date(cursor.occurredAt)),
        and(
          eq(events.occurredAt, new Date(cursor.occurredAt)),
          gt(events.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = await ctx.db.query.events.findMany({
    where: and(...conditions),
    orderBy: [asc(events.occurredAt), asc(events.id)],
    limit,
  });

  let processed = 0;
  let attentionHandled = 0;

  for (const row of rows) {
    if (isAttentionEvent(row.type) && row.projectId) {
      await handleAttentionEvent(ctx, {
        type: row.type,
        projectId: row.projectId,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        payload: row.payload as Record<string, unknown>,
      });
      attentionHandled += 1;
    }
    processed += 1;
    await writeAttentionDispatchCursor(ctx, {
      occurredAt: row.occurredAt.toISOString(),
      id: row.id,
    });
  }

  return { processed, attentionHandled };
}

/**
 * Drain the org-scoped outbox in bounded batches (per-org cursor in app_meta).
 */
export async function dispatchAttentionEvents(
  ctx: ServiceContext,
  limit = 100,
  maxBatches = 25,
): Promise<DispatchSummary> {
  let processed = 0;
  let attentionHandled = 0;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await dispatchAttentionEventsBatch(ctx, limit);
    processed += batch.processed;
    attentionHandled += batch.attentionHandled;
    if (batch.processed < limit) break;
  }
  return { processed, attentionHandled };
}
