import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attentionItems, closeDb, getDb, newId, runs, workItems } from '@nexus/db';
import {
  boardAttentionSummary,
  createContext,
  createProject,
  createWorkItem,
  executeAction,
  getAttentionItem,
  handleAttentionEvent,
  listInbox,
  pauseItemForBudget,
  reconcileAttention,
  setItemBudget,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { emit } from '../events/emit';
import { askQuestion } from '../questions';
import { upsertAttentionFromSource } from './projection';
import { listExpectedAttentionSources } from './sources';
import type { ServiceContext } from '../context';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

async function seedFailedRun(
  c: ServiceContext,
  projectId: string,
  workItemId: string,
): Promise<string> {
  const wi = await c.db.query.workItems.findFirst({ where: eq(workItems.id, workItemId) });
  if (!wi?.currentStageInstanceId) throw new Error('missing stage instance');
  const runId = newId();
  await c.db.insert(runs).values({
    id: runId,
    workItemId,
    stageInstanceId: wi.currentStageInstanceId,
    adapter: 'cloud_agent',
    trigger: { kind: 'test' },
    status: 'failed',
    nonce: `nonce-${runId}`,
    deadlineAt: new Date(Date.now() + 3_600_000),
    errorCode: 'test_fail',
    terminalAt: new Date(),
    providerUrl: 'https://cursor.com/agents/test-run',
  });
  await c.db.update(workItems).set({ currentRunId: runId }).where(eq(workItems.id, workItemId));
  await handleAttentionEvent(c, {
    type: 'run.failed',
    projectId,
    subjectType: 'run',
    subjectId: runId,
    payload: { workItemId, errorCode: 'test_fail' },
  });
  return runId;
}

function wrapDbWithQueryCounter(ctx: ServiceContext) {
  let queries = 0;
  const base = ctx.db;
  const wrapped = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return new Proxy(target.query, {
          get(qt, table) {
            const tableObj = Reflect.get(qt, table, qt) as Record<string, unknown>;
            if (!tableObj || typeof tableObj !== 'object') return tableObj;
            return new Proxy(tableObj, {
              get(to, method) {
                const fn = Reflect.get(to, method, to);
                if (typeof fn !== 'function') return fn;
                return (...args: unknown[]) => {
                  queries += 1;
                  return (fn as (...a: unknown[]) => unknown).apply(to, args);
                };
              },
            });
          },
        });
      }
      if (prop === 'execute' || prop === 'select') {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    ctx: { ...ctx, db: wrapped as typeof base },
    getQueries: () => queries,
  };
}

describe.runIf(hasDb)('attention blockers (B1–B8)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';
  let outsiderId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-block-${Date.now()}`,
      email: `p6-block-${Date.now()}@example.com`,
      name: 'Blocker',
    });
    orgId = u.orgId;
    userId = u.userId;
    const o = await upsertUserFromPassport(db, {
      externalSub: `p6-out-${Date.now()}`,
      email: `o-${Date.now()}@example.com`,
      name: 'Outsider',
    });
    outsiderId = o.userId;
  });

  function ctx(actorId = userId) {
    return createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: actorId },
      flags: { async isEnabled() { return true; } },
    });
  }

  it('B1: kind mismatch converges after reconcile (no perpetual drift)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('BK1'),
      name: 'B1',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, { projectId: project.value.id, title: 'k' });
    if (!item.ok) throw new Error(item.error.message);

    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    const runSrc = sources.find((s) => s.sourceType === 'run');
    if (!runSrc) return;

    const rowId = await upsertAttentionFromSource(c, {
      ...runSrc,
      kind: 'run_completed_no_report',
    });

    await db
      .update(attentionItems)
      .set({ kind: 'run_failed' })
      .where(eq(attentionItems.id, rowId));

    const drifts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await reconcileAttention(c, [project.value.id]);
      drifts.push(s.drift);
    }
    expect(drifts[drifts.length - 1]).toBe(0);
    expect(drifts.filter((d) => d > 0).length).toBeLessThanOrEqual(1);
  });

  it('B3: budget.item_overridden resolves inbox row', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('BK3'),
      name: 'B3',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, { projectId: project.value.id, title: 'budget' });
    if (!item.ok) throw new Error(item.error.message);

    await pauseItemForBudget(c, item.value.id, 'over budget');
    await reconcileAttention(c, [project.value.id]);

    const before = await listInbox(c, { projectIds: [project.value.id] });
    expect(before.ok && before.value.totalOpen).toBeGreaterThan(0);

    await setItemBudget(c, item.value.id, {
      micro: BigInt(50_000_000),
      reason: 'test override',
    });

    await handleAttentionEvent(c, {
      type: 'budget.item_overridden',
      projectId: project.value.id,
      subjectType: 'work_item',
      subjectId: item.value.id,
      payload: { workItemId: item.value.id },
    });

    const after = await listInbox(c, { projectIds: [project.value.id], kinds: ['budget_block'] });
    expect(after.ok && after.value.totalOpen).toBe(0);
  });

  it('M14/M16: outsider cannot list, get, or act on inbox rows', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('AUTH'),
      name: 'Auth',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, { projectId: project.value.id, title: 'x' });
    if (!item.ok) throw new Error(item.error.message);

    await emit(db, {
      orgId,
      projectId: project.value.id,
      type: 'question.asked',
      subjectType: 'question',
      subjectId: item.value.id,
      actor: { kind: 'human', userId },
      payload: { blocking: true, workItemId: item.value.id },
    });

    const out = ctx(outsiderId);
    const list = await listInbox(out, {});
    expect(list.ok && list.value.groups.length).toBe(0);

    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    const q = sources.find((s) => s.kind === 'blocking_question');
    if (!q) return;
    const id = await upsertAttentionFromSource(c, q);

    expect((await getAttentionItem(out, id)).ok).toBe(false);
    const act = await executeAction(out, {
      attentionItemId: id,
      action: 'open_ticket',
    });
    expect(act.ok).toBe(false);
    if (!act.ok) {
      expect(act.error.code).toBe('forbidden');
      expect(act.error.message).toContain('You cannot perform this action');
    }
  });

  it('B2: run retry resolves failed-run row and reconcile reports zero drift', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('BK2'),
      name: 'B2',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, { projectId: project.value.id, title: 'retry' });
    if (!item.ok) throw new Error(item.error.message);

    const failedRunId = await seedFailedRun(c, project.value.id, item.value.id);
    const before = await listInbox(c, { projectIds: [project.value.id], kinds: ['run_failed'] });
    expect(before.ok && before.value.totalOpen).toBe(1);

    const newRunId = newId();
    const wi = await c.db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    if (!wi?.currentStageInstanceId) throw new Error('missing stage');
    await c.db.insert(runs).values({
      id: newRunId,
      workItemId: item.value.id,
      stageInstanceId: wi.currentStageInstanceId,
      adapter: 'cloud_agent',
      trigger: { kind: 'retry' },
      status: 'running',
      nonce: `nonce-${newRunId}`,
      deadlineAt: new Date(Date.now() + 3_600_000),
      launchedAt: new Date(),
    });
    await c.db
      .update(workItems)
      .set({ currentRunId: newRunId })
      .where(eq(workItems.id, item.value.id));

    await handleAttentionEvent(c, {
      type: 'run.launched',
      projectId: project.value.id,
      subjectType: 'run',
      subjectId: newRunId,
      payload: { workItemId: item.value.id },
    });

    const after = await listInbox(c, { projectIds: [project.value.id], kinds: ['run_failed'] });
    expect(after.ok && after.value.totalOpen).toBe(0);

    const openRow = await db.query.attentionItems.findFirst({
      where: eq(attentionItems.sourceId, failedRunId),
    });
    expect(openRow?.status).toBe('resolved');

    const summary = await reconcileAttention(c, [project.value.id]);
    expect(summary.drift).toBe(0);
  });

  it('B6: open_cursor and loop_return dispatch on run_failed (not unknown action)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('BK6'),
      name: 'B6',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, { projectId: project.value.id, title: 'failed' });
    if (!item.ok) throw new Error(item.error.message);

    const failedRunId = await seedFailedRun(c, project.value.id, item.value.id);
    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    const runSrc = sources.find((s) => s.sourceId === failedRunId);
    if (!runSrc) throw new Error('missing run source');
    const attId = await upsertAttentionFromSource(c, runSrc);

    const open = await executeAction(c, {
      attentionItemId: attId,
      action: 'open_cursor',
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.value.detail?.navigate).toContain('cursor.com');

    const stages = await import('../projects/stages').then((m) =>
      m.listStages(c, project.value.id),
    );
    if (!stages.ok || stages.value.length < 2) return;

    const failedAgain = await seedFailedRun(c, project.value.id, item.value.id);
    const sources2 = await listExpectedAttentionSources(c, [project.value.id]);
    const runSrc2 = sources2.find((s) => s.sourceId === failedAgain);
    if (!runSrc2) throw new Error('missing run source 2');
    const attId2 = await upsertAttentionFromSource(c, runSrc2);

    const returned = await executeAction(c, {
      attentionItemId: attId2,
      action: 'loop_return',
      payload: { note: 'return from failed run' },
    });
    expect(returned.ok || !String(returned.ok ? '' : returned.error.message).includes('Unknown action')).toBe(
      true,
    );
  });

  it('B7: boardAttentionSummary query count is bounded vs item count', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('BK7'),
      name: 'B7',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);

    for (let i = 0; i < 60; i++) {
      const item = await createWorkItem(c, {
        projectId: project.value.id,
        title: `board ${i}`,
      });
      if (!item.ok) throw new Error(item.error.message);
    }

    const { ctx: counted, getQueries } = wrapDbWithQueryCounter(c);
    await boardAttentionSummary(counted, project.value.id);
    expect(getQueries()).toBeLessThan(120);
  });

  it('B8: pagination, invalid cursor, and kind filter semantics', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('BK8'),
      name: 'B8',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);

    for (let i = 0; i < 12; i++) {
      const item = await createWorkItem(c, {
        projectId: project.value.id,
        title: `page ${i}`,
      });
      if (!item.ok) throw new Error(item.error.message);
      await askQuestion(c, {
        ticketId: item.value.id,
        text: `Q page ${i}`,
        blocking: true,
        options: ['A'],
      });
      await reconcileAttention(c, [project.value.id]);
    }

    const budgetItem = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'budget page',
    });
    if (!budgetItem.ok) throw new Error(budgetItem.error.message);
    await pauseItemForBudget(c, budgetItem.value.id, 'cap');
    await reconcileAttention(c, [project.value.id]);

    const page1 = await listInbox(c, { projectIds: [project.value.id], limit: 5 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.groups.flatMap((g) => g.items).length).toBe(5);
    expect(page1.value.nextCursor).toBeTruthy();

    const page2 = await listInbox(c, {
      projectIds: [project.value.id],
      limit: 5,
      cursor: page1.value.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.groups.flatMap((g) => g.items).length).toBe(5);

    const badCursor = await listInbox(c, {
      projectIds: [project.value.id],
      cursor: 'not-a-valid-cursor',
    });
    expect(badCursor.ok).toBe(false);

    const budgetOnly = await listInbox(c, {
      projectIds: [project.value.id],
      kinds: ['budget_block'],
    });
    expect(budgetOnly.ok).toBe(true);
    if (!budgetOnly.ok) return;
    expect(budgetOnly.value.totalOpen).toBe(1);
    expect(budgetOnly.value.groups.flatMap((g) => g.items).length).toBe(1);
    expect(budgetOnly.value.groups[0]?.kind).toBe('budget_block');
  });
});
