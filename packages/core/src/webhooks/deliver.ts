import { eq, inArray, sql } from 'drizzle-orm';
import { projects, webhookDeliveries, webhookEndpoints, newId } from '@nexus/db';
import type { ServiceContext } from '../context';
import { can } from '../authz/can';
import { getProjectRole } from '../projects/members';
import { decryptWebhookSecret } from './secret-crypto';
import { assertPublicWebhookUrl } from './ssrf';
import {
  AUTO_DISABLE_CONSECUTIVE_FAILURES,
  buildSignatureHeader,
  classifyHttpStatus,
  MAX_WEBHOOK_BODY_BYTES,
  nextBackoffSec,
} from './signing';
import { buildPublicEnvelope } from './dispatch';

export type DeliverSummary = {
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
};

const FETCH_TIMEOUT_MS = 10_000;

function serializeWebhookBody(envelope: Record<string, unknown>): {
  body: string;
  truncated: boolean;
} {
  let working: Record<string, unknown> = {
    ...envelope,
    truncated: false,
    full_object_url: null,
  };
  let body = JSON.stringify(working);
  if (Buffer.byteLength(body, 'utf8') <= MAX_WEBHOOK_BODY_BYTES) {
    return { body, truncated: false };
  }

  working = { ...working, truncated: true };
  const data = working.data;
  if (data && typeof data === 'object') {
    let dataJson = JSON.stringify(data);
    while (
      dataJson.length > 2 &&
      Buffer.byteLength(JSON.stringify({ ...working, data: JSON.parse(dataJson) }), 'utf8') >
        MAX_WEBHOOK_BODY_BYTES
    ) {
      dataJson = dataJson.slice(0, Math.floor(dataJson.length * 0.85));
      try {
        JSON.parse(dataJson);
      } catch {
        dataJson = dataJson.slice(0, -1);
      }
    }
    try {
      working.data = JSON.parse(dataJson);
    } catch {
      working.data = { _truncated: true };
    }
  }

  body = JSON.stringify(working);
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    working = {
      id: working.id,
      type: working.type,
      version: working.version,
      occurred_at: working.occurred_at,
      truncated: true,
      full_object_url: null,
      data: { _truncated: true },
    };
    body = JSON.stringify(working);
  }
  return { body, truncated: true };
}

async function postWebhook(
  url: string,
  secret: string,
  body: string,
  headers: Record<string, string>,
  ssrf: { allowLoopback?: boolean },
): Promise<{ status: number; body: string; ms: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Nexus-Webhooks/1',
        ...headers,
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) await assertPublicWebhookUrl(loc, { allowLoopback: ssrf.allowLoopback });
      return {
        status: res.status,
        body: 'redirect_not_followed',
        ms: Date.now() - start,
      };
    }

    const text = await res.text().catch(() => '');
    return { status: res.status, body: text.slice(0, 2000), ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverPendingWebhooks(
  ctx: ServiceContext,
  limit = 50,
): Promise<DeliverSummary> {
  const now = ctx.clock();
  const nowIso = now.toISOString();
  const claimed = await ctx.db.execute(sql`
    UPDATE webhook_deliveries AS wd
    SET attempts = wd.attempts
    WHERE wd.id IN (
      SELECT wd2.id
      FROM webhook_deliveries wd2
      INNER JOIN webhook_endpoints we ON we.id = wd2.endpoint_id
      INNER JOIN projects p ON p.id = we.project_id
      WHERE wd2.status = 'pending'
        AND p.org_id = ${ctx.orgId}
        AND (wd2.next_attempt_at IS NULL OR wd2.next_attempt_at <= ${nowIso}::timestamptz)
      ORDER BY wd2.next_attempt_at ASC NULLS FIRST
      FOR UPDATE OF wd2 SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING wd.id
  `);
  const claimRows = claimed as unknown as Array<{ id: string }>;
  const deliveryIds = claimRows.map((r) => r.id).filter(Boolean);
  if (deliveryIds.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0, dead: 0 };
  }
  const due = await ctx.db.query.webhookDeliveries.findMany({
    where: inArray(webhookDeliveries.id, deliveryIds),
    orderBy: (t, { asc }) => [asc(t.nextAttemptAt)],
  });

  let delivered = 0;
  let failed = 0;
  let dead = 0;

  for (const delivery of due) {
    const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
      where: eq(webhookEndpoints.id, delivery.endpointId),
    });
    if (!endpoint || !endpoint.enabled) {
      await ctx.db
        .update(webhookDeliveries)
        .set({
          status: 'failed',
          error: 'endpoint_disabled',
          attempts: delivery.attempts + 1,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      failed += 1;
      continue;
    }

    const endpointProject = await ctx.db.query.projects.findFirst({
      where: eq(projects.id, endpoint.projectId),
    });
    if (!endpointProject || endpointProject.orgId !== ctx.orgId) {
      continue;
    }

    const envelope = await buildPublicEnvelope(ctx, delivery.eventId);
    if (!envelope) {
      await ctx.db
        .update(webhookDeliveries)
        .set({ status: 'failed', error: 'missing_event', attempts: delivery.attempts + 1 })
        .where(eq(webhookDeliveries.id, delivery.id));
      failed += 1;
      continue;
    }

    let truncated = false;
    const serialized = serializeWebhookBody(envelope as Record<string, unknown>);
    const body = serialized.body;
    truncated = serialized.truncated;

    let secret: string;
    try {
      secret = decryptWebhookSecret(endpoint.secretEncrypted);
    } catch {
      await ctx.db
        .update(webhookDeliveries)
        .set({ status: 'dead', error: 'secret_decrypt_failed' })
        .where(eq(webhookDeliveries.id, delivery.id));
      dead += 1;
      continue;
    }

    const sig = buildSignatureHeader(secret, body);
    const headers = {
      'x-nexus-signature': sig,
      'x-nexus-event-id': String(envelope.id),
      'x-nexus-event-type': String(envelope.type),
      'x-nexus-delivery-id': delivery.id,
    };

    let result: { status: number; body: string; ms: number };
    try {
      await assertPublicWebhookUrl(endpoint.url, {
        allowLoopback: ctx.webhookSsrfAllowLoopback,
      });
      result = await postWebhook(endpoint.url, secret, body, headers, {
        allowLoopback: ctx.webhookSsrfAllowLoopback,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'delivery_error';
      const attempts = delivery.attempts + 1;
      const classification = 'retry';
      await applyDeliveryFailure(ctx, delivery.id, endpoint.id, {
        attempts,
        error: msg,
        classification,
        responseStatus: null,
        responseBody: null,
        responseMs: null,
        requestBytes: Buffer.byteLength(body, 'utf8'),
        truncated,
      });
      failed += 1;
      continue;
    }

    const cls = classifyHttpStatus(result.status);
    if (cls === 'success') {
      await ctx.db
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          deliveredAt: ctx.clock(),
          attempts: delivery.attempts + 1,
          responseStatus: result.status,
          responseBodyExcerpt: result.body.slice(0, 500),
          responseMs: result.ms,
          requestBodyBytes: Buffer.byteLength(body, 'utf8'),
          requestTruncated: truncated,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      await ctx.db
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0, updatedAt: ctx.clock() })
        .where(eq(webhookEndpoints.id, endpoint.id));
      delivered += 1;
    } else {
      const attempts = delivery.attempts + 1;
      await applyDeliveryFailure(ctx, delivery.id, endpoint.id, {
        attempts,
        error: `http_${result.status}`,
        classification: cls,
        responseStatus: result.status,
        responseBody: result.body,
        responseMs: result.ms,
        requestBytes: Buffer.byteLength(body, 'utf8'),
        truncated,
      });
      if (cls === 'permanent_failure') failed += 1;
      else if (attempts >= 6) dead += 1;
      else failed += 1;
    }
  }

  return { attempted: due.length, delivered, failed, dead };
}

async function applyDeliveryFailure(
  ctx: ServiceContext,
  deliveryId: string,
  endpointId: string,
  input: {
    attempts: number;
    error: string;
    classification: 'retry' | 'permanent_failure';
    responseStatus: number | null;
    responseBody: string | null;
    responseMs: number | null;
    requestBytes: number;
    truncated: boolean;
  },
): Promise<void> {
  const maxAttempts = 6;
  let status: 'pending' | 'failed' | 'dead' = 'pending';
  let nextAttemptAt: Date | null = new Date(
    ctx.clock().getTime() + nextBackoffSec(input.attempts) * 1000,
  );
  if (input.classification === 'permanent_failure') {
    status = 'failed';
    nextAttemptAt = null;
  } else if (input.attempts >= maxAttempts) {
    status = 'dead';
    nextAttemptAt = null;
  }

  await ctx.db
    .update(webhookDeliveries)
    .set({
      status,
      attempts: input.attempts,
      nextAttemptAt,
      error: input.error,
      responseStatus: input.responseStatus,
      responseBodyExcerpt: input.responseBody?.slice(0, 500) ?? null,
      responseMs: input.responseMs,
      requestBodyBytes: input.requestBytes,
      requestTruncated: input.truncated,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  const ep = await ctx.db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, endpointId),
  });
  if (!ep) return;
  if (status === 'failed' || status === 'dead') {
    const consecutive = ep.consecutiveFailures + 1;
    const patch: Partial<typeof webhookEndpoints.$inferInsert> = {
      consecutiveFailures: consecutive,
      updatedAt: ctx.clock(),
    };
    if (consecutive >= AUTO_DISABLE_CONSECUTIVE_FAILURES) {
      patch.enabled = false;
      patch.disabledAt = ctx.clock();
      patch.disabledReason = 'consecutive_failures';
    }
    await ctx.db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, endpointId));
  }
}

export async function replayWebhookDelivery(
  ctx: ServiceContext,
  deliveryId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const existing = await ctx.db.query.webhookDeliveries.findFirst({
    where: eq(webhookDeliveries.id, deliveryId),
  });
  if (!existing) return { ok: false, message: 'not_found' };

  const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, existing.endpointId),
  });
  if (!endpoint) return { ok: false, message: 'not_found' };

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, endpoint.projectId),
  });
  if (!project || project.orgId !== ctx.orgId) {
    return { ok: false, message: 'forbidden' };
  }

  const role = await getProjectRole(ctx, endpoint.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: endpoint.projectId,
      role,
    })
  ) {
    return { ok: false, message: 'forbidden' };
  }

  const replayId = newId();
  await ctx.db.insert(webhookDeliveries).values({
    id: replayId,
    endpointId: existing.endpointId,
    eventId: existing.eventId,
    eventType: existing.eventType,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: ctx.clock(),
  });
  return { ok: true };
}

export async function countPendingDeliveries(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.db.execute(sql`
    select count(*)::int as c from webhook_deliveries where status = 'pending'
  `);
  const arr = rows as unknown as Array<{ c: number }>;
  return Number(arr[0]?.c ?? 0);
}
