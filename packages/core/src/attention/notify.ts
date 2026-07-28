import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  attentionItems,
  newId,
  notificationChannels,
  notificationDeliveries,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import { kindSeverity } from './weights';

const COALESCE_WINDOW_MS = 5 * 60 * 1000;
const PER_ITEM_COOLDOWN_MS = 60 * 60 * 1000;
const COALESCE_DEBOUNCE_MS = 30;
const ALLOWED_SECRET_PREFIX = 'NEXUS_WEBHOOK_';

const channelFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function publicBaseUrl(): string {
  const raw =
    process.env.DEPLOYMENT_URL ??
    process.env.NEXUS_PUBLIC_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    'http://localhost:3000';
  return raw.replace(/\/$/, '');
}

function resolveWebhookUrl(secretKey: string): string | null {
  if (!secretKey.startsWith(ALLOWED_SECRET_PREFIX)) return null;
  return process.env[secretKey] ?? null;
}

export async function deliverWithRetries(
  ctx: ServiceContext,
  deliveryId: string,
  webhookUrl: string,
  body: Record<string, unknown>,
): Promise<void> {
  const maxAttempts = 4;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await ctx.db
        .update(notificationDeliveries)
        .set({
          status: 'delivered',
          deliveredAt: ctx.clock(),
          attempts: attempt,
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  await ctx.db
    .update(notificationDeliveries)
    .set({
      status: 'failed',
      attempts: maxAttempts,
      lastError: lastError.slice(0, 500),
    })
    .where(eq(notificationDeliveries.id, deliveryId));
}

async function flushChannelDeliveries(
  ctx: ServiceContext,
  channelId: string,
  webhookUrl: string,
): Promise<void> {
  const windowStart = new Date(ctx.clock().getTime() - COALESCE_WINDOW_MS);
  const pending = await ctx.db.query.notificationDeliveries.findMany({
    where: and(
      eq(notificationDeliveries.channelId, channelId),
      eq(notificationDeliveries.status, 'pending'),
      gte(notificationDeliveries.createdAt, windowStart),
    ),
  });
  if (pending.length === 0) return;

  const itemIds = pending
    .map((d) => d.attentionItemId)
    .filter((id): id is string => Boolean(id));
  const coalesced = pending.length >= 2;
  const lead = pending[0]!;
  const body = coalesced
    ? {
        text: `Nexus: ${pending.length} items need attention on this project. Open inbox: ${publicBaseUrl()}/inbox`,
        coalesced: true,
        count: pending.length,
      }
    : await (async () => {
        const row = itemIds[0]
          ? await ctx.db.query.attentionItems.findFirst({
              where: eq(attentionItems.id, itemIds[0]),
            })
          : null;
        const link = row
          ? `${publicBaseUrl()}/inbox?item=${row.id}`
          : `${publicBaseUrl()}/inbox`;
        return {
          text: row ? `${row.title}\n${row.why}\n${link}` : `Nexus inbox: ${link}`,
          attentionItemId: row?.id,
          kind: row?.kind,
          link,
        };
      })();

  const rollupId = newId();
  if (coalesced) {
    await ctx.db.insert(notificationDeliveries).values({
      id: rollupId,
      channelId,
      attentionItemId: null,
      status: 'pending',
      attempts: 0,
    });
    await deliverWithRetries(ctx, rollupId, webhookUrl, body);
    await ctx.db
      .update(notificationDeliveries)
      .set({ status: 'delivered', deliveredAt: ctx.clock() })
      .where(
        inArray(
          notificationDeliveries.id,
          pending.map((p) => p.id),
        ),
      );
    return;
  }

  await deliverWithRetries(ctx, lead.id, webhookUrl, body);
}

function scheduleChannelFlush(
  ctx: ServiceContext,
  channelId: string,
  webhookUrl: string,
): void {
  const existing = channelFlushTimers.get(channelId);
  if (existing) clearTimeout(existing);
  channelFlushTimers.set(
    channelId,
    setTimeout(() => {
      channelFlushTimers.delete(channelId);
      void flushChannelDeliveries(ctx, channelId, webhookUrl);
    }, COALESCE_DEBOUNCE_MS),
  );
}

export async function flushPendingNotifications(ctx: ServiceContext): Promise<void> {
  const channels = await ctx.db.query.notificationChannels.findMany({
    where: eq(notificationChannels.enabled, true),
  });
  for (const channel of channels) {
    const webhookUrl = resolveWebhookUrl(channel.secretKey);
    if (!webhookUrl) continue;
    const pending = channelFlushTimers.get(channel.id);
    if (pending) {
      clearTimeout(pending);
      channelFlushTimers.delete(channel.id);
    }
    await flushChannelDeliveries(ctx, channel.id, webhookUrl);
  }
}

export async function notifyAttentionItemCreated(
  ctx: ServiceContext,
  attentionItemId: string,
): Promise<void> {
  const row = await ctx.db.query.attentionItems.findFirst({
    where: eq(attentionItems.id, attentionItemId),
  });
  if (!row || row.status !== 'open') return;

  const channels = await ctx.db.query.notificationChannels.findMany({
    where: and(
      eq(notificationChannels.projectId, row.projectId),
      eq(notificationChannels.enabled, true),
    ),
  });
  if (channels.length === 0) return;

  const windowStart = new Date(ctx.clock().getTime() - COALESCE_WINDOW_MS);

  for (const channel of channels) {
    const severity = kindSeverity(row.kind as never);
    if (channel.minKindSeverity !== 'all') {
      const min = Number(channel.minKindSeverity);
      if (!Number.isNaN(min) && severity < min) continue;
    }

    const recentSame = await ctx.db.query.notificationDeliveries.findMany({
      where: and(
        eq(notificationDeliveries.channelId, channel.id),
        eq(notificationDeliveries.attentionItemId, row.id),
        gte(notificationDeliveries.createdAt, new Date(ctx.clock().getTime() - PER_ITEM_COOLDOWN_MS)),
      ),
      limit: 1,
    });
    if (recentSame.length > 0) continue;

    const recentBurst = await ctx.db.query.notificationDeliveries.findMany({
      where: and(
        eq(notificationDeliveries.channelId, channel.id),
        gte(notificationDeliveries.createdAt, windowStart),
      ),
    });
    const alreadyCoalesced = recentBurst.some(
      (d) => d.attentionItemId === null && d.status === 'delivered',
    );
    if (alreadyCoalesced) {
      await ctx.db.insert(notificationDeliveries).values({
        id: newId(),
        channelId: channel.id,
        attentionItemId: row.id,
        status: 'delivered',
        attempts: 0,
        deliveredAt: ctx.clock(),
      });
      continue;
    }

    const webhookUrl = resolveWebhookUrl(channel.secretKey);
    if (!webhookUrl) continue;

    await ctx.db.insert(notificationDeliveries).values({
      id: newId(),
      channelId: channel.id,
      attentionItemId: row.id,
      status: 'pending',
      attempts: 0,
    });

    scheduleChannelFlush(ctx, channel.id, webhookUrl);
  }
}
