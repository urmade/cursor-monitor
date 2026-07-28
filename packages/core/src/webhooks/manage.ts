import { and, desc, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints } from '@nexus/db';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { err, ok, type Result } from '../result';
import { can } from '../authz/can';
import { getProjectRole } from '../projects/members';
import {
  createWebhookEndpoint,
  dispatchWebhookEvents,
} from './dispatch';
import { deliverPendingWebhooks, replayWebhookDelivery } from './deliver';
import { buildSignatureHeader } from './signing';
import { decryptWebhookSecret } from './secret-crypto';
import { assertPublicWebhookUrl } from './ssrf';

export async function listWebhookEndpoints(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<(typeof webhookEndpoints.$inferSelect)[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.update', { type: 'project', projectId, role })) {
    return err(coreError('forbidden', 'Cannot list webhooks'));
  }
  const rows = await ctx.db.query.webhookEndpoints.findMany({
    where: eq(webhookEndpoints.projectId, projectId),
    orderBy: [desc(webhookEndpoints.createdAt)],
  });
  return ok(rows);
}

export async function listWebhookDeliveries(
  ctx: ServiceContext,
  endpointId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<Result<(typeof webhookDeliveries.$inferSelect)[], CoreError>> {
  const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, endpointId),
  });
  if (!endpoint) return err(coreError('not_found', 'Endpoint not found'));
  const role = await getProjectRole(ctx, endpoint.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: endpoint.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot list deliveries'));
  }
  const rows = await ctx.db.query.webhookDeliveries.findMany({
    where: opts.status
      ? and(
          eq(webhookDeliveries.endpointId, endpointId),
          eq(webhookDeliveries.status, opts.status as 'pending'),
        )
      : eq(webhookDeliveries.endpointId, endpointId),
    orderBy: [desc(webhookDeliveries.createdAt)],
    limit: opts.limit ?? 100,
  });
  return ok(rows);
}

export { replayWebhookDelivery };

export async function sendTestWebhookEvent(
  ctx: ServiceContext,
  endpointId: string,
): Promise<Result<{ deliveryId: string }, CoreError>> {
  const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, endpointId),
  });
  if (!endpoint) return err(coreError('not_found', 'Endpoint not found'));
  const role = await getProjectRole(ctx, endpoint.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: endpoint.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot test endpoint'));
  }

  try {
    await assertPublicWebhookUrl(endpoint.url, {
      allowLoopback: ctx.webhookSsrfAllowLoopback,
    });
  } catch (e) {
    return err(coreError('validation', e instanceof Error ? e.message : 'Invalid URL'));
  }

  const envelope = {
    id: 'evt_test_ping',
    type: 'nexus.endpoint.test',
    version: 1,
    occurred_at: ctx.clock().toISOString(),
    project: { id: endpoint.projectId, key: 'test' },
    subject: { type: 'endpoint', id: endpointId },
    actor: { kind: 'system', reason: 'test_event' },
    data: { ping: true },
  };
  const body = JSON.stringify(envelope);
  let secret: string;
  try {
    secret = decryptWebhookSecret(endpoint.secretEncrypted);
  } catch {
    return err(coreError('invariant', 'Could not decrypt endpoint secret'));
  }
  const sig = buildSignatureHeader(secret, body);
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nexus-signature': sig,
      'x-nexus-event-id': envelope.id,
      'x-nexus-event-type': envelope.type,
      'x-nexus-delivery-id': 'test',
    },
    body,
    redirect: 'manual',
  });
  if (res.status < 200 || res.status >= 300) {
    return err(
      coreError('provider_error', `Test delivery failed with HTTP ${res.status}`),
    );
  }

  return ok({ deliveryId: 'test' });
}

export async function reEnableWebhookEndpoint(
  ctx: ServiceContext,
  endpointId: string,
): Promise<Result<void, CoreError>> {
  const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.id, endpointId),
  });
  if (!endpoint) return err(coreError('not_found', 'Endpoint not found'));
  const role = await getProjectRole(ctx, endpoint.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: endpoint.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot re-enable endpoint'));
  }
  if (!endpoint.disabledAt) {
    return err(coreError('validation', 'Endpoint is not disabled'));
  }

  const test = await sendTestWebhookEvent(ctx, endpointId);
  if (!test.ok) return test;

  await ctx.db
    .update(webhookEndpoints)
    .set({
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      consecutiveFailures: 0,
      updatedAt: ctx.clock(),
    })
    .where(eq(webhookEndpoints.id, endpointId));

  return ok(undefined);
}

export { createWebhookEndpoint, dispatchWebhookEvents, deliverPendingWebhooks };
