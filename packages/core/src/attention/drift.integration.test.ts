import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attentionItems, closeDb, getDb, workItems } from '@nexus/db';
import {
  askQuestion,
  createContext,
  createProject,
  createWorkItem,
  pauseItemForBudget,
  reconcileAttention,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { handleAttentionEvent } from './handlers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('attention drift convergence', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-drift-${Date.now()}`,
      email: `p6-drift-${Date.now()}@example.com`,
      name: 'P6 Drift',
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

  it('reconciliation reports zero drift after hundreds of source mutations', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('DRIFT'),
      name: 'Drift',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const pid = project.value.id;

    for (let i = 0; i < 40; i++) {
      const item = await createWorkItem(c, {
        projectId: pid,
        title: `Drift item ${i}`,
      });
      if (!item.ok) throw new Error(item.error.message);
      if (i % 5 === 0) {
        await askQuestion(c, {
          ticketId: item.value.id,
          text: `Q ${i}`,
          blocking: true,
          options: ['A', 'B'],
        });
      }
      if (i % 7 === 0) {
        await pauseItemForBudget(c, item.value.id, 'test pause');
        await handleAttentionEvent(c, {
          type: 'budget.blocked',
          projectId: pid,
          subjectType: 'work_item',
          subjectId: item.value.id,
          payload: { workItemId: item.value.id },
        });
      }
      if (i % 11 === 0) {
        await db
          .update(workItems)
          .set({ loopEscalated: true, updatedAt: new Date() })
          .where(eq(workItems.id, item.value.id));
        await handleAttentionEvent(c, {
          type: 'loop.escalated',
          projectId: pid,
          subjectType: 'work_item',
          subjectId: item.value.id,
          payload: {},
        });
      }
    }

    let lastDrift = -1;
    for (let round = 0; round < 5; round++) {
      const summary = await reconcileAttention(c, [pid]);
      lastDrift = summary.drift;
      if (summary.drift === 0) break;
    }

    const open = await db.query.attentionItems.findMany({
      where: eq(attentionItems.projectId, pid),
    });
    expect(open.filter((r) => r.status === 'open').length).toBeGreaterThan(0);
    expect(lastDrift).toBe(0);
  }, 120_000);
});
