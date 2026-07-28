import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { closeDb, events, newId, webhookDeliveries } from '@nexus/db';
import { testDb } from '../test-helpers/db';
import { emit } from '../events/emit';
import {
  createContext,
  createProject,
  createWebhookEndpoint,
  dispatchWebhookEvents,
  dispatchWebhookEventsDrain,
  advanceWebhookOutboxCursorToLatest,
  readOutboxCursor,
  upsertUserFromPassport,
  webhookDispatcherCursorKey,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('webhook dispatch backlog latency', () => {
  const BACKLOG = 2_500;
  const BATCH = 100;

  afterAll(async () => {
    await closeDb();
  });

  async function seedBacklog(
    db: ReturnType<typeof testDb>,
    orgId: string,
    projectId: string,
    count: number,
  ) {
    const cursor = await readOutboxCursor(db, webhookDispatcherCursorKey(orgId));
    const baseMs = cursor ? new Date(cursor.occurredAt).getTime() + 1 : Date.now();
    const chunk = 200;
    for (let offset = 0; offset < count; offset += chunk) {
      const rows = [];
      const n = Math.min(chunk, count - offset);
      for (let i = 0; i < n; i += 1) {
        const idx = offset + i;
        rows.push({
          id: newId(),
          orgId,
          projectId,
          type: 'work_item.created',
          publicType: 'work_item.created' as const,
          subjectType: 'work_item' as const,
          subjectId: projectId,
          actor: { kind: 'system' as const, reason: 'backlog_seed' },
          payload: { key: `BK-${idx}`, title: 'backlog' },
          occurredAt: new Date(baseMs + idx),
        });
      }
      await db.insert(events).values(rows);
    }
  }

  it('single-batch dispatch needs multiple ticks to reach a new event behind backlog', async () => {
    const db = testDb();
    const u = await upsertUserFromPassport(db, {
      externalSub: `p8-backlog-${Date.now()}`,
      email: `backlog-${Date.now()}@example.com`,
      name: 'Backlog',
    });

    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { isEnabled: async () => true },
    });

    const noise = await createProject(ctx, {
      key: testProjectKey('BN'),
      name: 'Backlog noise',
      template: 'default',
    });
    expect(noise.ok).toBe(true);
    if (!noise.ok) throw new Error('noise project');

    const target = await createProject(ctx, {
      key: testProjectKey('TG'),
      name: 'Backlog target',
      template: 'default',
    });
    expect(target.ok).toBe(true);
    if (!target.ok) throw new Error('target project');

    await advanceWebhookOutboxCursorToLatest(db, u.orgId);
    await seedBacklog(db, u.orgId, noise.value.id, BACKLOG);

    const ep = await createWebhookEndpoint(ctx, {
      projectId: target.value.id,
      url: 'https://1.1.1.1/nexus-backlog-test',
      eventTypes: ['work_item.created'],
    });
    expect(ep.ok).toBe(true);
    if (!ep.ok) throw new Error(ep.error.message);

    const latestAfterSeed = await db.query.events.findMany({
      orderBy: [desc(events.occurredAt), desc(events.id)],
      limit: 1,
    });
    const tailMs = (latestAfterSeed[0]?.occurredAt.getTime() ?? Date.now()) + 10;

    const eventId = await emit(db, {
      orgId: u.orgId,
      projectId: target.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: target.value.id,
      actor: { kind: 'human', userId: u.userId },
      payload: { key: 'TGT-1', title: 'After backlog' },
      occurredAt: new Date(tailMs),
    });

    let ticks = 0;
    let delivered = false;
    while (ticks < 50) {
      ticks += 1;
      await dispatchWebhookEvents(ctx, BATCH);
      const row = await db.query.webhookDeliveries.findFirst({
        where: and(
          eq(webhookDeliveries.eventId, eventId),
          eq(webhookDeliveries.endpointId, ep.value.endpoint.id),
        ),
      });
      if (row) {
        delivered = true;
        break;
      }
    }

    expect(delivered).toBe(true);
    expect(ticks).toBeGreaterThanOrEqual(Math.ceil(BACKLOG / BATCH));
    expect(ticks).toBeLessThanOrEqual(Math.ceil(BACKLOG / BATCH) + 1);
  });

  it('drain reaches a new event in one job invocation', async () => {
    const db = testDb();
    const u = await upsertUserFromPassport(db, {
      externalSub: `p8-drain-${Date.now()}`,
      email: `drain-${Date.now()}@example.com`,
      name: 'Drain',
    });

    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { isEnabled: async () => true },
    });

    const noise = await createProject(ctx, {
      key: testProjectKey('DN'),
      name: 'Drain noise',
      template: 'default',
    });
    if (!noise.ok) throw new Error('noise');

    const target = await createProject(ctx, {
      key: testProjectKey('DL'),
      name: 'Drain target',
      template: 'default',
    });
    if (!target.ok) throw new Error('target');

    await advanceWebhookOutboxCursorToLatest(db, u.orgId);
    await seedBacklog(db, u.orgId, noise.value.id, BACKLOG);

    const ep = await createWebhookEndpoint(ctx, {
      projectId: target.value.id,
      url: 'https://1.1.1.1/nexus-drain-test',
      eventTypes: ['work_item.created'],
    });
    if (!ep.ok) throw new Error('endpoint');

    const latestAfterSeed = await db.query.events.findMany({
      orderBy: [desc(events.occurredAt), desc(events.id)],
      limit: 1,
    });
    const tailMs = (latestAfterSeed[0]?.occurredAt.getTime() ?? Date.now()) + 10;

    const eventId = await emit(db, {
      orgId: u.orgId,
      projectId: target.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: target.value.id,
      actor: { kind: 'human', userId: u.userId },
      payload: { key: 'DRN-1', title: 'Drain target' },
      occurredAt: new Date(tailMs),
    });

    const summary = await dispatchWebhookEventsDrain(ctx, {
      batchSize: BATCH,
      maxBatches: 50,
    });
    expect(summary.eventsScanned).toBeGreaterThanOrEqual(BACKLOG);

    const delivery = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.eventId, eventId),
        eq(webhookDeliveries.endpointId, ep.value.endpoint.id),
      ),
    });
    expect(delivery).toBeDefined();
  });
});
