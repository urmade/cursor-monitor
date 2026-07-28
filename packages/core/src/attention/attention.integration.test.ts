import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attentionItems, closeDb, getDb } from '@nexus/db';
import {
  askQuestion,
  answerQuestion,
  createContext,
  createProject,
  createWorkItem,
  reconcileAttention,
  listExpectedAttentionSources,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('phase 6 attention', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `p6-${Date.now()}@example.com`,
      name: 'P6',
    });
    orgId = u.orgId;
    userId = u.userId;
  });

  function ctx() {
    return createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: {
        async isEnabled() {
          return true;
        },
      },
    });
  }

  it('reconciliation creates blocking question row and detects injected drift', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P6'),
      name: 'P6 Attention',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Inbox item',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);

    const q = await askQuestion(c, {
      ticketId: item.value.id,
      text: 'Which auth provider?',
      blocking: true,
      options: ['Okta', 'Auth0'],
    });
    expect(q.ok).toBe(true);
    if (!q.ok) throw new Error(q.error.message);

    const summary = await reconcileAttention(c, [project.value.id]);
    expect(summary.drift).toBeGreaterThan(0);
    expect(summary.created).toBeGreaterThanOrEqual(1);

    const open = await db.query.attentionItems.findMany({
      where: eq(attentionItems.status, 'open'),
    });
    const row = open.find((r) => r.sourceId === q.value.question.id);
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('blocking_question');
    expect(row?.why).toContain(item.value.key);

    const answer = await answerQuestion(c, q.value.question.id, 'Okta', {
      resume: false,
    });
    expect(answer.ok).toBe(true);

    const summary2 = await reconcileAttention(c, [project.value.id]);
    expect(summary2.resolved).toBeGreaterThanOrEqual(1);

    const stale = await db.query.attentionItems.findFirst({
      where: eq(attentionItems.sourceId, q.value.question.id),
    });
    expect(stale?.status).toBe('resolved');
  });

  it('expected sources include open blocking questions', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P6B'),
      name: 'P6B',
      template: 'minimal',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Q',
    });
    if (!item.ok) throw new Error(item.error.message);
    await askQuestion(c, {
      ticketId: item.value.id,
      text: 'Pick one',
      blocking: true,
    });
    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    expect(sources.some((s) => s.kind === 'blocking_question')).toBe(true);
  });
});
