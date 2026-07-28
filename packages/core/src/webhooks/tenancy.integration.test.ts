import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, events, newId, orgs, users, webhookDeliveries } from '@nexus/db';
import { testDb } from '../test-helpers/db';
import { emit } from '../events/emit';
import {
  createContext,
  createProject,
  createWebhookEndpoint,
  dispatchWebhookEvents,
  webhookDispatcherCursorKey,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

const EPOCH_CURSOR = {
  occurredAt: '1970-01-01T00:00:00.000Z',
  eventId: '00000000-0000-0000-0000-000000000001',
};

describe.runIf(hasDb)('webhook dispatcher org tenancy', () => {
  const BACKLOG = 80;
  const BATCH = 100;

  afterAll(async () => {
    await closeDb();
  });

  async function createIsolatedOrg(slug: string) {
    const db = testDb();
    const orgId = newId();
    await db.insert(orgs).values({ id: orgId, name: slug, slug });
    const userId = newId();
    await db.insert(users).values({
      id: userId,
      orgId,
      externalSub: `tenancy-${slug}-${Date.now()}`,
      email: `${slug}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return { orgId, userId };
  }

  async function seedOrgBacklog(
    db: ReturnType<typeof testDb>,
    orgId: string,
    projectId: string,
    count: number,
    baseMs: number,
  ) {
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
          actor: { kind: 'system' as const, reason: 'tenancy_backlog' },
          payload: { key: `BK-${idx}`, title: 'backlog' },
          occurredAt: new Date(baseMs + idx),
        });
      }
      await db.insert(events).values(rows);
    }
  }

  it('two orgs each receive a delivery in one dispatch pass despite the other org backlog', async () => {
    const db = testDb();
    const baseMs = Date.now();

    const orgA = await createIsolatedOrg(`org-a-${Date.now().toString(36)}`);
    const orgB = await createIsolatedOrg(`org-b-${Date.now().toString(36)}`);

    const ctxA = createContext({
      db,
      orgId: orgA.orgId,
      actor: { kind: 'human', userId: orgA.userId },
      flags: { isEnabled: async () => true },
    });
    const ctxB = createContext({
      db,
      orgId: orgB.orgId,
      actor: { kind: 'human', userId: orgB.userId },
      flags: { isEnabled: async () => true },
    });

    const projectA = await createProject(ctxA, {
      key: testProjectKey('TNA'),
      name: 'Org A',
      template: 'default',
    });
    const projectB = await createProject(ctxB, {
      key: testProjectKey('TNB'),
      name: 'Org B',
      template: 'default',
    });
    if (!projectA.ok || !projectB.ok) throw new Error('projects');

    const epA = await createWebhookEndpoint(ctxA, {
      projectId: projectA.value.id,
      url: 'https://1.1.1.1/tenancy-a',
      eventTypes: ['work_item.created'],
    });
    const epB = await createWebhookEndpoint(ctxB, {
      projectId: projectB.value.id,
      url: 'https://1.1.1.1/tenancy-b',
      eventTypes: ['work_item.created'],
    });
    if (!epA.ok || !epB.ok) throw new Error('endpoints');

    const { writeOutboxCursor } = await import('../events/outbox-cursor');
    await writeOutboxCursor(db, webhookDispatcherCursorKey(orgA.orgId), EPOCH_CURSOR);
    await writeOutboxCursor(db, webhookDispatcherCursorKey(orgB.orgId), EPOCH_CURSOR);

    await seedOrgBacklog(db, orgB.orgId, projectB.value.id, BACKLOG, baseMs);

    const eventA = await emit(db, {
      orgId: orgA.orgId,
      projectId: projectA.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: projectA.value.id,
      actor: { kind: 'human', userId: orgA.userId },
      payload: { key: 'A-TAIL', title: 'Org A tail' },
      occurredAt: new Date(baseMs + BACKLOG + 1),
    });

    const eventB = await emit(db, {
      orgId: orgB.orgId,
      projectId: projectB.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: projectB.value.id,
      actor: { kind: 'human', userId: orgB.userId },
      payload: { key: 'B-TAIL', title: 'Org B tail' },
      occurredAt: new Date(baseMs + BACKLOG + 2),
    });

    const summaryA = await dispatchWebhookEvents(ctxA, BATCH);
    const summaryB = await dispatchWebhookEvents(ctxB, BATCH);

    expect(summaryA.eventsScanned).toBe(1);
    expect(summaryA.deliveriesCreated).toBe(1);
    expect(summaryB.eventsScanned).toBe(BACKLOG + 1);
    expect(summaryB.deliveriesCreated).toBeGreaterThanOrEqual(1);

    const deliveryA = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.eventId, eventA),
        eq(webhookDeliveries.endpointId, epA.value.endpoint.id),
      ),
    });
    const deliveryB = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.eventId, eventB),
        eq(webhookDeliveries.endpointId, epB.value.endpoint.id),
      ),
    });

    expect(deliveryA).toBeDefined();
    expect(deliveryB).toBeDefined();
  });
});
