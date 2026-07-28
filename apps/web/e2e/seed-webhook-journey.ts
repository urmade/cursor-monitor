/**
 * Seeds a failed webhook delivery on ALPHA for Playwright §9 (replay journey).
 * Requires DB_POSTGRES_URL and prior `pnpm db:seed -- --demo`.
 */
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, webhookDeliveries, webhookEndpoints } from '@nexus/db';
import {
  createContext,
  createWebhookEndpoint,
  createWorkItem,
  deliverPendingWebhooks,
  dispatchWebhookEvents,
  getProjectByKey,
  upsertUserFromPassport,
  advanceWebhookOutboxCursorToLatest,
} from '@nexus/core';

const FAIL_URL = 'https://httpbin.org/status/404';
const E2E_DESCRIPTION = 'E2E webhook journey';

async function main(): Promise<void> {
  const db = getDb();
  const { userId, orgId } = await upsertUserFromPassport(db, {
    externalSub: 'local-dev-user',
    email: 'local@example.com',
    name: 'Local Dev',
  });
  const ctx = createContext({
    db,
    orgId,
    actor: { kind: 'human', userId },
    flags: { isEnabled: async () => true },
  });

  const project = await getProjectByKey(ctx, 'ALPHA');
  if (!project.ok) {
    throw new Error('ALPHA project missing — run pnpm db:seed -- --demo first');
  }

  const existing = await db.query.webhookEndpoints.findFirst({
    where: (t, { and: a, eq: e }) =>
      a(e(t.projectId, project.value.id), e(t.description, E2E_DESCRIPTION)),
  });

  let endpointId: string;
  if (existing) {
    endpointId = existing.id;
    if (existing.url !== FAIL_URL) {
      await db
        .update(webhookEndpoints)
        .set({ url: FAIL_URL, enabled: true, consecutiveFailures: 0 })
        .where(eq(webhookEndpoints.id, endpointId));
    }
  } else {
    const ep = await createWebhookEndpoint(ctx, {
      projectId: project.value.id,
      url: FAIL_URL,
      eventTypes: ['work_item.created'],
      description: E2E_DESCRIPTION,
    });
    if (!ep.ok) throw new Error(ep.error.message);
    endpointId = ep.value.endpoint.id;
  }

  await advanceWebhookOutboxCursorToLatest(db, orgId);

  const title = `E2E webhook delivery ${Date.now()}`;
  const created = await createWorkItem(ctx, {
    projectId: project.value.id,
    title,
  });
  if (!created.ok) throw new Error(created.error.message);

  const disp = await dispatchWebhookEvents(ctx, 100);
  if (disp.deliveriesCreated === 0) {
    throw new Error('dispatch created no deliveries');
  }

  for (let i = 0; i < 20; i += 1) {
    await deliverPendingWebhooks(ctx, 50);
    const failed = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.status, 'failed'),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    if (failed) {
      console.log(JSON.stringify({ ok: true, deliveryId: failed.id, endpointId }));
      await closeDb();
      return;
    }
    const pending = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.status, 'pending'),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    if (!pending) {
      throw new Error('no pending delivery for endpoint after dispatch');
    }
  }

  throw new Error('failed delivery not created after dispatch/deliver');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
