import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  newId,
  notificationChannels,
  notificationDeliveries,
} from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  flushPendingNotifications,
  notifyAttentionItemCreated,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { upsertAttentionFromSource } from './projection';
import { listExpectedAttentionSources } from './sources';
import { askQuestion } from '../questions';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('attention notifications (B5)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-notify-${Date.now()}`,
      email: `p6-notify-${Date.now()}@example.com`,
      name: 'Notify',
    });
    orgId = u.orgId;
    userId = u.userId;
  });

  function ctx() {
    return createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { async isEnabled() { return true; } },
    });
  }

  it('B5: burst of ten items → one webhook POST and ten delivery rows (per channel)', async () => {
    const secretKey = 'NEXUS_WEBHOOK_TEST_BURST';
    process.env[secretKey] = 'https://example.test/webhook';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('NB5'),
      name: 'B5',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);

    const channelId = newId();
    await db.insert(notificationChannels).values({
      id: channelId,
      projectId: project.value.id,
      kind: 'http_webhook',
      secretKey,
      minKindSeverity: 'all',
      enabled: true,
    });

    const attentionIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const item = await createWorkItem(c, {
        projectId: project.value.id,
        title: `burst ${i}`,
      });
      if (!item.ok) throw new Error(item.error.message);
      const q = await askQuestion(c, {
        ticketId: item.value.id,
        text: `Q ${i}`,
        blocking: true,
        options: ['A'],
      });
      if (!q.ok) throw new Error(q.error.message);
      const sources = await listExpectedAttentionSources(c, [project.value.id]);
      const match = sources.find(
        (s) => s.sourceType === 'question' && s.sourceId === q.value.question.id,
      );
      if (!match) throw new Error('missing source');
      attentionIds.push(await upsertAttentionFromSource(c, match));
    }

    for (const id of attentionIds) {
      await notifyAttentionItemCreated(c, id);
    }
    await flushPendingNotifications(c);

    const deliveries = await db.query.notificationDeliveries.findMany({
      where: eq(notificationDeliveries.channelId, channelId),
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    delete process.env[secretKey];
  });

  it('B5: burst window is scoped per channel', async () => {
    const keyA = 'NEXUS_WEBHOOK_TEST_CH_A';
    const keyB = 'NEXUS_WEBHOOK_TEST_CH_B';
    process.env[keyA] = 'https://example.test/a';
    process.env[keyB] = 'https://example.test/b';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('NCH'),
      name: 'channels',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);

    const chA = newId();
    const chB = newId();
    await db.insert(notificationChannels).values([
      {
        id: chA,
        projectId: project.value.id,
        kind: 'http_webhook',
        secretKey: keyA,
        minKindSeverity: 'all',
        enabled: true,
      },
      {
        id: chB,
        projectId: project.value.id,
        kind: 'http_webhook',
        secretKey: keyB,
        minKindSeverity: 'all',
        enabled: true,
      },
    ]);

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'dual channel',
    });
    if (!item.ok) throw new Error(item.error.message);
    const q = await askQuestion(c, {
      ticketId: item.value.id,
      text: 'dual',
      blocking: true,
      options: ['A'],
    });
    if (!q.ok) throw new Error(q.error.message);
    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    const match = sources.find((s) => s.sourceId === q.value.question.id);
    if (!match) throw new Error('no source');
    const attId = await upsertAttentionFromSource(c, match);

    await notifyAttentionItemCreated(c, attId);
    await flushPendingNotifications(c);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    delete process.env[keyA];
    delete process.env[keyB];
  });

  it('B5: failed delivery retries with backoff before terminal failure', async () => {
    const secretKey = 'NEXUS_WEBHOOK_TEST_RETRY';
    process.env[secretKey] = 'https://example.test/retry';
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error('network');
        return { ok: true, status: 200, text: async () => '' };
      }),
    );

    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('NRT'),
      name: 'retry',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);

    const channelId = newId();
    await db.insert(notificationChannels).values({
      id: channelId,
      projectId: project.value.id,
      kind: 'http_webhook',
      secretKey,
      minKindSeverity: 'all',
      enabled: true,
    });

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'retry',
    });
    if (!item.ok) throw new Error(item.error.message);
    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    const q = await askQuestion(c, {
      ticketId: item.value.id,
      text: 'retry q',
      blocking: true,
      options: ['A'],
    });
    if (!q.ok) throw new Error(q.error.message);
    const match = sources.find((s) => s.sourceType === 'question') ??
      (await listExpectedAttentionSources(c, [project.value.id])).find(
        (s) => s.sourceType === 'question',
      );
    if (!match) throw new Error('no match');
    const attId = await upsertAttentionFromSource(c, match);

    await notifyAttentionItemCreated(c, attId);
    await flushPendingNotifications(c);

    const delivery = await db.query.notificationDeliveries.findFirst({
      where: eq(notificationDeliveries.channelId, channelId),
    });
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempts).toBeGreaterThanOrEqual(3);

    vi.unstubAllGlobals();
    delete process.env[secretKey];
  });
});
