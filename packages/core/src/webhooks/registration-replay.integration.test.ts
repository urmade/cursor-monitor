import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, events, newId, webhookDeliveries } from '@nexus/db';
import { testDb } from '../test-helpers/db';
import {
  createContext,
  createProject,
  createWebhookEndpoint,
  dispatchWebhookEvents,
  advanceWebhookOutboxCursorToLatest,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { upsertUserFromPassport } from '../identity/upsert';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('webhook endpoint registration replay guard', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('does not deliver historical public events when an endpoint is first registered', async () => {
    const db = testDb();
    const u = await upsertUserFromPassport(db, {
      externalSub: `reg-replay-${Date.now()}`,
      email: `replay-${Date.now()}@example.com`,
      name: 'Replay',
    });
    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { isEnabled: async () => true },
    });

    const project = await createProject(ctx, {
      key: testProjectKey('RR'),
      name: 'Replay',
      template: 'default',
    });
    if (!project.ok) throw new Error('project');

    const baseMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const rows = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push({
        id: newId(),
        orgId: u.orgId,
        projectId: project.value.id,
        type: 'work_item.created',
        publicType: 'work_item.created' as const,
        subjectType: 'work_item' as const,
        subjectId: project.value.id,
        actor: { kind: 'system' as const, reason: 'history' },
        payload: { key: `OLD-${i}`, title: 'old' },
        occurredAt: new Date(baseMs + i * 1000),
      });
    }
    await db.insert(events).values(rows);

    const ep = await createWebhookEndpoint(ctx, {
      projectId: project.value.id,
      url: 'https://1.1.1.1/no-replay',
      eventTypes: ['work_item.created'],
    });
    expect(ep.ok).toBe(true);
    if (!ep.ok) throw new Error(ep.error.message);

    await advanceWebhookOutboxCursorToLatest(db, u.orgId);

    const summary = await dispatchWebhookEvents(ctx, 200);
    expect(summary.deliveriesCreated).toBe(0);
    const queued = await db.query.webhookDeliveries.findMany({
      where: eq(webhookDeliveries.endpointId, ep.value.endpoint.id),
    });
    expect(queued.length).toBe(0);
  });
});
