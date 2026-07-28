import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, webhookDeliveries } from '@nexus/db';
import { testDb } from '../test-helpers/db';
import { emit } from '../events/emit';
import {
  webhookDispatcherCursorKey,
  readOutboxCursor,
  writeOutboxCursor,
  compareEventOrder,
  createContext,
  createWebhookEndpoint,
  dispatchAttentionEvents,
  dispatchWebhookEvents,
  upsertUserFromPassport,
} from '../index';
import {
  readAttentionDispatchCursor,
  writeAttentionDispatchCursor,
} from '../attention/dispatch-cursor';
import { testProjectKey } from '../cost/test-helpers';
import { createProject } from '../projects/create';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('outbox per-consumer cursors', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('attention and webhook dispatchers both observe the same new event', async () => {
    const db = testDb();
    const u = await upsertUserFromPassport(db, {
      externalSub: `p8-cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `p8-${Date.now()}@example.com`,
      name: 'P8',
    });

    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { isEnabled: async () => true },
    });

    const project = await createProject(ctx, {
      key: testProjectKey('P8O'),
      name: 'Outbox',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project');

    const ep = await createWebhookEndpoint(ctx, {
      projectId: project.value.id,
      url: 'https://1.1.1.1/nexus-webhook-test',
      eventTypes: ['work_item.created'],
    });
    expect(ep.ok).toBe(true);
    if (!ep.ok) throw new Error(ep.error.message);

    const eventId = await emit(db, {
      orgId: u.orgId,
      projectId: project.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: project.value.id,
      actor: { kind: 'human', userId: u.userId },
      payload: { key: 'X-1', title: 'Test' },
    });

    const row = await db.query.events.findFirst({
      where: (e, { eq: eqFn }) => eqFn(e.id, eventId),
    });
    expect(row?.publicType).toBe('work_item.created');
    const eventRow = row!;

    await writeOutboxCursor(db, webhookDispatcherCursorKey(u.orgId), {
      occurredAt: new Date(eventRow.occurredAt.getTime() - 1000).toISOString(),
      eventId: '00000000-0000-0000-0000-000000000000',
    });
    await writeAttentionDispatchCursor(ctx, {
      occurredAt: new Date(eventRow.occurredAt.getTime() - 1000).toISOString(),
      id: '00000000-0000-0000-0000-000000000000',
    });

    await dispatchAttentionEvents(ctx, 50);
    const attCursorAfter = await readAttentionDispatchCursor(ctx);
    expect(attCursorAfter).toBeTruthy();
    expect(
      compareEventOrder(
        { occurredAt: eventRow.occurredAt, id: eventRow.id },
        { occurredAt: attCursorAfter!.occurredAt, eventId: attCursorAfter!.id },
      ),
    ).toBeLessThanOrEqual(0);

    let delivery = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.eventId, eventId),
        eq(webhookDeliveries.endpointId, ep.value.endpoint.id),
      ),
    });
    for (let i = 0; i < 30 && !delivery; i += 1) {
      await dispatchWebhookEvents(ctx, 50);
      delivery = await db.query.webhookDeliveries.findFirst({
        where: and(
          eq(webhookDeliveries.eventId, eventId),
          eq(webhookDeliveries.endpointId, ep.value.endpoint.id),
        ),
      });
    }
    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe('pending');

    const whCursor = await readOutboxCursor(db, webhookDispatcherCursorKey(u.orgId));
    expect(
      compareEventOrder(
        { occurredAt: eventRow.occurredAt, id: eventRow.id },
        whCursor!,
      ),
    ).toBeLessThanOrEqual(0);
  });
});
