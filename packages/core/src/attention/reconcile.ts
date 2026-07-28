import { and, eq, inArray, sql } from 'drizzle-orm';
import { attentionItems, attentionReconciliations, appMeta, newId } from '@nexus/db';
import type { ServiceContext } from '../context';
import {
  resolveAttentionBySource,
  rescoreOpenItems,
  upsertAttentionFromSource,
} from './projection';
import { listExpectedAttentionSources } from './sources';

export type ReconciliationSummary = {
  created: number;
  resolved: number;
  drift: number;
  detail: Record<string, unknown>;
};

export async function reconcileAttention(
  ctx: ServiceContext,
  projectIds?: string[],
): Promise<ReconciliationSummary> {
  let ids = projectIds;
  if (!ids || ids.length === 0) {
    const rows = await ctx.db.execute(sql`
      select id from projects where org_id = ${ctx.orgId}
    `);
    const arr = rows as unknown as Array<{ id: string }>;
    ids = arr.map((r) => r.id);
  }

  const expected = await listExpectedAttentionSources(ctx, ids);
  const expectedKeys = new Map<string, (typeof expected)[number]>(
    expected.map((e) => [`${e.sourceType}:${e.sourceId}`, e]),
  );

  const openInScope = await ctx.db.query.attentionItems.findMany({
    where: and(eq(attentionItems.status, 'open'), inArray(attentionItems.projectId, ids)),
  });

  let created = 0;
  let repaired = 0;
  let resolved = 0;
  const driftItems: string[] = [];

  for (const exp of expected) {
    const key = `${exp.sourceType}:${exp.sourceId}`;
    const open = openInScope.find(
      (r) => r.sourceType === exp.sourceType && r.sourceId === exp.sourceId,
    );
    if (!open) {
      await upsertAttentionFromSource(ctx, exp);
      created += 1;
      driftItems.push(`missing:${key}`);
    } else if (open.kind !== exp.kind) {
      await upsertAttentionFromSource(ctx, exp);
      repaired += 1;
    }
  }

  for (const row of openInScope) {
    const key = `${row.sourceType}:${row.sourceId}`;
    if (!expectedKeys.has(key)) {
      await resolveAttentionBySource(ctx, row.sourceType, row.sourceId, 'reconcile_stale');
      resolved += 1;
      driftItems.push(`stale:${key}`);
    }
  }

  const drift = driftItems.length;
  await ctx.db.insert(attentionReconciliations).values({
    id: newId(),
    created,
    resolved,
    drift,
    detail: { items: driftItems.slice(0, 100), repaired },
  });

  await ctx.db
    .insert(appMeta)
    .values({
      key: 'attention_last_reconcile',
      value: {
        at: ctx.clock().toISOString(),
        drift,
        created,
        resolved,
      },
      updatedAt: ctx.clock(),
    })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: {
        value: {
          at: ctx.clock().toISOString(),
          drift,
          created,
          resolved,
        },
        updatedAt: ctx.clock(),
      },
    });

  await rescoreOpenItems(ctx);

  return { created, resolved, drift, detail: { items: driftItems } };
}

export async function readLastReconciliation(): Promise<{
  at: string | null;
  drift: number | null;
}> {
  const { getDb } = await import('@nexus/db');
  const db = getDb();
  const row = await db.query.appMeta.findFirst({
    where: eq(appMeta.key, 'attention_last_reconcile'),
  });
  const at = typeof row?.value?.at === 'string' ? row.value.at : null;
  const drift = typeof row?.value?.drift === 'number' ? row.value.drift : null;
  return { at, drift };
}
