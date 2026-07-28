import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  closeDb,
  newId,
  orgs,
  users,
  webhookDeliveries,
} from '@nexus/db';
import { testDb } from '../test-helpers/db';
import { emit } from '../events/emit';
import {
  createContext,
  createProject,
  createWebhookEndpoint,
  dispatchWebhookEvents,
  replayWebhookDelivery,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('replayWebhookDelivery tenancy', () => {
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
      externalSub: `replay-${slug}-${Date.now()}`,
      email: `${slug}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return { orgId, userId };
  }

  it('denies replay across orgs', async () => {
    const db = testDb();
    const orgA = await createIsolatedOrg(`ra-${Date.now().toString(36)}`);
    const orgB = await createIsolatedOrg(`rb-${Date.now().toString(36)}`);

    const ctxB = createContext({
      db,
      orgId: orgB.orgId,
      actor: { kind: 'human', userId: orgB.userId },
      flags: { isEnabled: async () => true },
    });

    const project = await createProject(ctxB, {
      key: testProjectKey('RP'),
      name: 'B',
      template: 'default',
    });
    if (!project.ok) throw new Error('project');

    const ep = await createWebhookEndpoint(ctxB, {
      projectId: project.value.id,
      url: 'https://1.1.1.1/replay-b',
      eventTypes: ['work_item.created'],
    });
    if (!ep.ok) throw new Error('ep');

    const eventId = await emit(db, {
      orgId: orgB.orgId,
      projectId: project.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: project.value.id,
      actor: { kind: 'human', userId: orgB.userId },
      payload: { key: 'B-1', title: 't' },
    });

    await dispatchWebhookEvents(ctxB, 10);

    const delivery = await db.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.eventId, eventId),
        eq(webhookDeliveries.endpointId, ep.value.endpoint.id),
      ),
    });
    expect(delivery).toBeDefined();
    if (!delivery) return;

    const ctxA = createContext({
      db,
      orgId: orgA.orgId,
      actor: { kind: 'human', userId: orgA.userId },
      flags: { isEnabled: async () => true },
    });

    const denied = await replayWebhookDelivery(ctxA, delivery.id);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.message).toBe('forbidden');
  });
});
