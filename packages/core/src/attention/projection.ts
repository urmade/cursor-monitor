import { and, eq } from 'drizzle-orm';
import { attentionItems, newId, workItems } from '@nexus/db';
import type { ServiceContext } from '../context';
import { emit } from '../events/emit';
import { computeAttentionScore } from './score';
import { defaultActions, titleAndWhy } from './templates';
import type { ExpectedAttentionSource } from './sources';
import { loadAttentionWeights } from './weights';

export async function upsertAttentionFromSource(
  ctx: ServiceContext,
  source: ExpectedAttentionSource,
): Promise<string> {
  const weights = await loadAttentionWeights(ctx);
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, source.workItemId),
  });
  const complexity =
    (item?.complexity as 'low' | 'medium' | 'high' | undefined) ?? 'medium';
  const spent = item?.spendMicroUsd ?? BigInt(0);
  const loopCount = item?.loopCount ?? 0;

  const existing = await ctx.db.query.attentionItems.findFirst({
    where: and(
      eq(attentionItems.sourceType, source.sourceType),
      eq(attentionItems.sourceId, source.sourceId),
      eq(attentionItems.status, 'open'),
    ),
  });

  const { title, why } = titleAndWhy({
    kind: source.kind,
    workItemKey: source.workItemKey,
    detail: source.detail,
  });
  let actions = defaultActions(source.kind);
  if (source.kind === 'blocking_question') {
    const opts = (source.detail.options as string[] | undefined) ?? [];
    const optionActs = opts.slice(0, 9).map((label, i) => ({
      id: `opt_${i}`,
      label,
      kind: 'answer',
      requiresConfirm: false,
    }));
    const freeText = actions.find((a) => a.id === 'answer');
    actions = [
      ...optionActs,
      ...(freeText ? [freeText] : []),
      ...actions.filter((a) => a.id !== 'answer'),
    ];
  }
  const scoreExplain = computeAttentionScore({
    kind: source.kind,
    createdAt: existing?.createdAt ?? source.createdAt,
    complexity,
    spentMicroUsd: spent,
    loopCount,
    snoozedUntil: existing?.snoozedUntil ?? null,
    now: ctx.clock(),
    weights,
  });

  if (existing) {
    await ctx.db
      .update(attentionItems)
      .set({
        kind: source.kind,
        title,
        why,
        askedOf: source.askedOf,
        score: scoreExplain.total,
        scoreExplain,
        actions,
      })
      .where(eq(attentionItems.id, existing.id));
    return existing.id;
  }

  const id = newId();
  await ctx.db.insert(attentionItems).values({
    id,
    projectId: source.projectId,
    workItemId: source.workItemId,
    kind: source.kind,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    title,
    why,
    askedOf: source.askedOf,
    status: 'open',
    score: scoreExplain.total,
    scoreExplain,
    actions,
    createdAt: source.createdAt,
  });

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: source.projectId,
    type: 'attention.created',
    subjectType: 'attention_item',
    subjectId: id,
    actor: ctx.actor,
    payload: { kind: source.kind, workItemId: source.workItemId },
  });

  const { notifyAttentionItemCreated } = await import('./notify');
  await notifyAttentionItemCreated(ctx, id).catch(() => undefined);

  return id;
}

export async function resolveAttentionBySource(
  ctx: ServiceContext,
  sourceType: string,
  sourceId: string,
  resolution: string,
): Promise<void> {
  const row = await ctx.db.query.attentionItems.findFirst({
    where: and(
      eq(attentionItems.sourceType, sourceType),
      eq(attentionItems.sourceId, sourceId),
      eq(attentionItems.status, 'open'),
    ),
  });
  if (!row) return;

  await ctx.db
    .update(attentionItems)
    .set({
      status: 'resolved',
      resolvedAt: ctx.clock(),
      resolvedBy: ctx.actor as Record<string, unknown>,
      resolution,
    })
    .where(eq(attentionItems.id, row.id));

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: row.projectId,
    type: 'attention.resolved',
    subjectType: 'attention_item',
    subjectId: row.id,
    actor: ctx.actor,
    payload: { resolution, kind: row.kind },
  });
}

export async function resolveAllForWorkItem(
  ctx: ServiceContext,
  workItemId: string,
  resolution: string,
): Promise<void> {
  const rows = await ctx.db.query.attentionItems.findMany({
    where: and(eq(attentionItems.workItemId, workItemId), eq(attentionItems.status, 'open')),
  });
  for (const row of rows) {
    await resolveAttentionBySource(ctx, row.sourceType, row.sourceId, resolution);
  }
}

export async function rescoreOpenItems(ctx: ServiceContext): Promise<number> {
  const weights = await loadAttentionWeights(ctx);
  const open = await ctx.db.query.attentionItems.findMany({
    where: eq(attentionItems.status, 'open'),
  });
  let updated = 0;
  for (const row of open) {
    const item = await ctx.db.query.workItems.findFirst({
      where: eq(workItems.id, row.workItemId),
    });
    if (!item) continue;
    const scoreExplain = computeAttentionScore({
      kind: row.kind as ExpectedAttentionSource['kind'],
      createdAt: row.createdAt,
      complexity: (item.complexity as 'low' | 'medium' | 'high') ?? 'medium',
      spentMicroUsd: item.spendMicroUsd ?? BigInt(0),
      loopCount: item.loopCount ?? 0,
      snoozedUntil: row.snoozedUntil,
      now: ctx.clock(),
      weights,
    });
    if (scoreExplain.total !== row.score) {
      await ctx.db
        .update(attentionItems)
        .set({ score: scoreExplain.total, scoreExplain })
        .where(eq(attentionItems.id, row.id));
      updated += 1;
    }
  }
  return updated;
}
