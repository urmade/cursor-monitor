import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attentionItems, closeDb, getDb } from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  dispatchAttentionEvents,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { askQuestion } from '../questions';
import { readAttentionDispatchCursor } from './dispatch-cursor';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('attention dispatch (M20)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-dispatch-${Date.now()}`,
      email: `p6-dispatch-${Date.now()}@example.com`,
      name: 'Dispatch',
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

  it('M20: dispatchAttentionEvents projects event → inbox row and advances cursor', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('DSP'),
      name: 'Dispatch',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'dispatch-only',
    });
    if (!item.ok) throw new Error(item.error.message);

    const asked = await askQuestion(c, {
      ticketId: item.value.id,
      text: 'Dispatch path only?',
      blocking: true,
      options: ['Yes'],
    });
    if (!asked.ok) throw new Error(asked.error.message);
    const questionId = asked.value.question.id;

    const openBefore = await db.query.attentionItems.findMany({
      where: and(
        eq(attentionItems.workItemId, item.value.id),
        eq(attentionItems.status, 'open'),
      ),
    });
    expect(openBefore.length).toBe(0);

    const cursorBefore = await readAttentionDispatchCursor(c);

    const summary = await dispatchAttentionEvents(c, 50);
    expect(summary.attentionHandled).toBeGreaterThan(0);

    const openAfter = await db.query.attentionItems.findMany({
      where: and(
        eq(attentionItems.workItemId, item.value.id),
        eq(attentionItems.status, 'open'),
        eq(attentionItems.sourceType, 'question'),
      ),
    });
    expect(openAfter.length).toBe(1);
    expect(openAfter[0]?.sourceId).toBe(questionId);

    const cursorAfter = await readAttentionDispatchCursor(c);
    expect(cursorAfter).not.toBeNull();
    if (cursorBefore && cursorAfter) {
      const advanced =
        cursorAfter.occurredAt > cursorBefore.occurredAt ||
        (cursorAfter.occurredAt === cursorBefore.occurredAt &&
          cursorAfter.id > cursorBefore.id);
      expect(advanced).toBe(true);
    }
  });
});
