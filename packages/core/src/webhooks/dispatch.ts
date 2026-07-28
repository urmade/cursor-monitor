import type { PublicEventType } from '@nexus/contracts';
import { PUBLIC_EVENTS } from '@nexus/contracts';
import { and, asc, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import {
  events,
  newId,
  projects,
  webhookDeliveries,
  webhookEndpoints,
  workItems,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { ok, err, type Result } from '../result';
import {
  resolveWebhookDispatcherCursor,
  webhookDispatcherCursorKey,
  writeOutboxCursor,
  isAfterCursor,
  ensureWebhookDispatcherCursorInitialized,
} from '../events/outbox-cursor';
import { hashToken, mintRawToken } from '../mcp/tokens';
import { encryptWebhookSecret } from './secret-crypto';
import { assertPublicWebhookUrl } from './ssrf';
import { projectPublicEventData, parsePublicEventData } from './public-projection';

export type DispatchWebhookSummary = {
  eventsScanned: number;
  deliveriesCreated: number;
};

export type DispatchWebhookDrainOptions = {
  batchSize?: number;
  /** Max single-job batches (default 50 × batchSize events per cron tick). */
  maxBatches?: number;
};

/** Drain the webhook outbox in global order within one job tick (bounded). */
export async function dispatchWebhookEventsDrain(
  ctx: ServiceContext,
  options: DispatchWebhookDrainOptions = {},
): Promise<DispatchWebhookSummary> {
  const batchSize = options.batchSize ?? 200;
  const maxBatches = options.maxBatches ?? 50;
  let eventsScanned = 0;
  let deliveriesCreated = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await dispatchWebhookEvents(ctx, batchSize);
    eventsScanned += batch.eventsScanned;
    deliveriesCreated += batch.deliveriesCreated;
    if (batch.eventsScanned < batchSize) break;
  }
  return { eventsScanned, deliveriesCreated };
}

export async function dispatchWebhookEvents(
  ctx: ServiceContext,
  limit = 100,
): Promise<DispatchWebhookSummary> {
  const cursor = await resolveWebhookDispatcherCursor(ctx.db, ctx.orgId);
  const cursorKey = webhookDispatcherCursorKey(ctx.orgId);
  const rows = await ctx.db.query.events.findMany({
    where: and(
      eq(events.orgId, ctx.orgId),
      isNotNull(events.publicType),
      cursor
        ? or(
            gt(events.occurredAt, new Date(cursor.occurredAt)),
            and(
              sql`${events.occurredAt} = ${cursor.occurredAt}::timestamptz`,
              gt(events.id, cursor.eventId),
            ),
          )
        : undefined,
    ),
    orderBy: [asc(events.occurredAt), asc(events.id)],
    limit,
  });

  let deliveriesCreated = 0;
  let lastCursor = cursor;

  for (const row of rows) {
    if (!isAfterCursor(row, lastCursor)) continue;
    if (!row.projectId || !row.publicType) {
      lastCursor = { occurredAt: row.occurredAt.toISOString(), eventId: row.id };
      continue;
    }

    const endpoints = await ctx.db.query.webhookEndpoints.findMany({
      where: and(
        eq(webhookEndpoints.projectId, row.projectId),
        eq(webhookEndpoints.enabled, true),
      ),
    });

    for (const ep of endpoints) {
      if (!ep.eventTypes.includes(row.publicType)) continue;
      if (row.occurredAt.getTime() < ep.createdAt.getTime()) continue;
      const deliveryId = newId();
      await ctx.db.insert(webhookDeliveries).values({
        id: deliveryId,
        endpointId: ep.id,
        eventId: row.id,
        eventType: row.publicType,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: ctx.clock(),
      });
      deliveriesCreated += 1;
    }

    lastCursor = { occurredAt: row.occurredAt.toISOString(), eventId: row.id };
  }

  if (lastCursor && lastCursor !== cursor) {
    await writeOutboxCursor(ctx.db, cursorKey, lastCursor);
  }

  return { eventsScanned: rows.length, deliveriesCreated };
}

export async function createWebhookEndpoint(
  ctx: ServiceContext,
  input: {
    projectId: string;
    url: string;
    eventTypes: PublicEventType[];
    description?: string;
  },
): Promise<Result<{ endpoint: typeof webhookEndpoints.$inferSelect; secret: string }, CoreError>> {
  try {
    await assertPublicWebhookUrl(input.url, {
      allowLoopback: ctx.webhookSsrfAllowLoopback,
    });
  } catch (e) {
    return err(coreError('validation', e instanceof Error ? e.message : 'Invalid URL'));
  }

  for (const t of input.eventTypes) {
    if (!(t in PUBLIC_EVENTS)) {
      return err(coreError('validation', `Unknown event type: ${t}`));
    }
  }

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, input.projectId),
  });
  if (!project || project.orgId !== ctx.orgId) {
    return err(coreError('forbidden', 'Project not in token org'));
  }

  const { raw } = mintRawToken();
  const secret = `whsec_${raw}`;
  const id = newId();
  const userId = ctx.actor.kind === 'human' ? ctx.actor.userId : null;

  await ctx.db.insert(webhookEndpoints).values({
    id,
    projectId: input.projectId,
    url: input.url,
    secretHash: hashToken(secret),
    secretEncrypted: encryptWebhookSecret(secret),
    eventTypes: input.eventTypes,
    description: input.description ?? null,
    createdByUserId: userId,
    updatedAt: ctx.clock(),
  });

  const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, id),
  });
  if (!endpoint) {
    return err(coreError('invariant', 'Failed to load created endpoint'));
  }

  await ensureWebhookDispatcherCursorInitialized(ctx.db, ctx.orgId);

  return ok({ endpoint, secret });
}

export async function buildPublicEnvelope(
  ctx: ServiceContext,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const row = await ctx.db.query.events.findFirst({
    where: eq(events.id, eventId),
  });
  if (!row?.publicType || !row.projectId) return null;

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, row.projectId),
  });
  if (!project) return null;

  let subjectKey: string | undefined;
  const projectionHints: { workItemKey?: string; stagePayload?: Record<string, unknown> } = {};
  if (row.subjectType === 'work_item') {
    const item = await ctx.db.query.workItems.findFirst({
      where: eq(workItems.id, row.subjectId),
    });
    subjectKey = item?.key;
  }

  if (row.publicType === 'work_item.stage_changed') {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const fromId = p.fromStageId as string | undefined;
    const toId = p.toStageId as string | undefined;
    const stageRows =
      fromId || toId
        ? await ctx.db.query.stages.findMany({
            where: (s, { inArray }) =>
              inArray(s.id, [fromId, toId].filter(Boolean) as string[]),
          })
        : [];
    const byId = new Map(stageRows.map((s) => [s.id, s]));
    projectionHints.stagePayload = {
      from: fromId && byId.get(fromId) ? { key: byId.get(fromId)!.key } : null,
      to: toId && byId.get(toId) ? { key: byId.get(toId)!.key, name: byId.get(toId)!.name } : { key: 'unknown' },
      direction: p.direction,
      reason_code: p.reasonCode ?? p.reason_code ?? null,
    };
  }

  const publicType = row.publicType as PublicEventType;
  const version = PUBLIC_EVENTS[publicType]?.version ?? 1;

  let data: Record<string, unknown>;
  try {
    const base = projectionHints.stagePayload
      ? projectionHints.stagePayload
      : projectPublicEventData(
          {
            type: row.type,
            publicType: row.publicType as string,
            subjectId: row.subjectId,
            payload: row.payload,
          },
          { workItemKey: subjectKey },
        );
    data = parsePublicEventData(publicType, base as Record<string, unknown>);
  } catch (e) {
    throw new Error(
      `public_event_projection_failed:${publicType}:${e instanceof Error ? e.message : 'invalid'}`,
    );
  }

  return {
    id: `evt_${row.id.replace(/-/g, '').slice(0, 26)}`,
    type: publicType,
    version,
    occurred_at: row.occurredAt.toISOString(),
    project: { id: project.id, key: project.key },
    subject: {
      type: row.subjectType,
      id: row.subjectId,
      ...(subjectKey ? { key: subjectKey } : {}),
    },
    actor: row.actor,
    data,
    truncated: false,
    full_object_url: null as string | null,
  };
}
