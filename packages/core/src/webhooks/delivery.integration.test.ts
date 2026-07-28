import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { closeDb, newId, orgs, users, webhookDeliveries } from '@nexus/db';
import { testDb } from '../test-helpers/db';
import {
  createContext,
  createProject,
  createWebhookEndpoint,
  dispatchWebhookEvents,
  deliverPendingWebhooks,
  emit,
  verifyWebhookSignature,
  webhookDispatcherCursorKey,
  writeOutboxCursor,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('webhook HTTP delivery', () => {
  let server: Server | undefined;
  let received: { body: string; sig: string } | null = null;

  afterAll(async () => {
    server?.close();
    await closeDb();
  });

  it('POSTs a signed payload to a loopback listener', async () => {
    const db = testDb();
    received = null;
    const orgId = newId();
    const slug = `http-org-${Date.now().toString(36)}`;
    await db.insert(orgs).values({ id: orgId, name: slug, slug });
    const userId = newId();
    await db.insert(users).values({
      id: userId,
      orgId,
      externalSub: `p8-http-${Date.now()}`,
      email: `p8h-${Date.now()}@example.com`,
      displayName: 'P8H',
      lastSeenAt: new Date(),
    });
    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { isEnabled: async () => true },
      webhookSsrfAllowLoopback: true,
    });

    const project = await createProject(ctx, {
      key: testProjectKey('P8H'),
      name: 'HTTP',
      template: 'default',
    });
    if (!project.ok) throw new Error('project');

    const port = await new Promise<number>((resolve, reject) => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received = {
            body: Buffer.concat(chunks).toString('utf8'),
            sig: String(req.headers['x-nexus-signature'] ?? ''),
          };
          res.writeHead(200);
          res.end('ok');
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        if (!addr || typeof addr === 'string') reject(new Error('no addr'));
        else resolve(addr.port);
      });
    });

    const ep = await createWebhookEndpoint(ctx, {
      projectId: project.value.id,
      url: `http://127.0.0.1:${port}/hook`,
      eventTypes: ['work_item.created'],
    });
    expect(ep.ok).toBe(true);
    if (!ep.ok) throw new Error(ep.error.message);

    await writeOutboxCursor(db, webhookDispatcherCursorKey(orgId), {
      occurredAt: '1970-01-01T00:00:00.000Z',
      eventId: '00000000-0000-0000-0000-000000000001',
    });

    const eventId = await emit(db, {
      orgId: orgId,
      projectId: project.value.id,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: project.value.id,
      actor: { kind: 'human', userId },
      payload: { key: 'H-1', title: 'HTTP test' },
    });

    let row = await db.query.webhookDeliveries.findFirst({
      where: and(eq(webhookDeliveries.eventId, eventId)),
    });
    for (let i = 0; i < 30 && !row; i += 1) {
      await dispatchWebhookEvents(ctx, 50);
      row = await db.query.webhookDeliveries.findFirst({
        where: and(eq(webhookDeliveries.eventId, eventId)),
      });
    }
    expect(row).toBeDefined();

    for (let i = 0; i < 30 && row?.status !== 'delivered'; i += 1) {
      await deliverPendingWebhooks(ctx, 50);
      row = await db.query.webhookDeliveries.findFirst({
        where: and(eq(webhookDeliveries.eventId, eventId)),
      });
    }

    expect(received).not.toBeNull();
    expect(verifyWebhookSignature(ep.value.secret, received!.body, received!.sig).ok).toBe(
      true,
    );

    expect(row?.status).toBe('delivered');
  });
});