import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attentionItems, closeDb, events } from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  dispatchAttentionEvents,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { testDb } from '../test-helpers/db';
import { askQuestion } from '../questions';
import { readAttentionDispatchCursor, writeAttentionDispatchCursor } from './dispatch-cursor';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('attention dispatch (M20)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('M20: dispatchAttentionEvents projects event → inbox row and advances cursor', async () => {
    const db = testDb();
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `p6-dispatch-${Date.now()}@example.com`,
      name: 'Dispatch',
    });

    const c = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { async isEnabled() { return true; } },
    });

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

    const qEvent = await db.query.events.findFirst({
      where: and(
        eq(events.orgId, u.orgId),
        eq(events.type, 'question.asked'),
        eq(events.subjectId, questionId),
      ),
    });
    expect(qEvent).toBeDefined();
    if (!qEvent) throw new Error('question.asked event');

    await writeAttentionDispatchCursor(c, {
      occurredAt: new Date(qEvent.occurredAt.getTime() - 1000).toISOString(),
      id: '00000000-0000-0000-0000-000000000000',
    });

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
