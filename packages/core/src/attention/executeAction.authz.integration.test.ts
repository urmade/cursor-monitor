import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  executeAction,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';
import { askQuestion } from '../questions';
import { upsertAttentionFromSource } from './projection';
import { listExpectedAttentionSources } from './sources';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

/**
 * M14: executeAction must enforce work_item.update at the inbox boundary.
 * Outsider `answer` can fail inside question.answer; this test uses open_ticket
 * so only executeAction authz distinguishes pass vs fail.
 */
describe.runIf(hasDb)('executeAction authz (M14)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';
  let outsiderId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p6-m14-${Date.now()}`,
      email: `p6-m14-${Date.now()}@example.com`,
      name: 'M14',
    });
    orgId = u.orgId;
    userId = u.userId;
    const o = await upsertUserFromPassport(db, {
      externalSub: `p6-m14-out-${Date.now()}`,
      email: `o-m14-${Date.now()}@example.com`,
      name: 'Out',
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

  it('outsider open_ticket is forbidden at executeAction (not downstream)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('M14'),
      name: 'M14',
      template: 'default',
    });
    if (!project.ok) throw new Error(project.error.message);
    const item = await createWorkItem(c, { projectId: project.value.id, title: 'x' });
    if (!item.ok) throw new Error(item.error.message);

    const asked = await askQuestion(c, {
      ticketId: item.value.id,
      text: 'Auth boundary?',
      blocking: true,
      options: ['A'],
    });
    if (!asked.ok) throw new Error(asked.error.message);

    const sources = await listExpectedAttentionSources(c, [project.value.id]);
    const q = sources.find((s) => s.sourceId === asked.value.question.id);
    if (!q) throw new Error('missing source');
    const id = await upsertAttentionFromSource(c, q);

    const owner = await executeAction(c, {
      attentionItemId: id,
      action: 'open_ticket',
    });
    expect(owner.ok).toBe(true);

    const act = await executeAction(ctx(outsiderId), {
      attentionItemId: id,
      action: 'open_ticket',
    });
    expect(act.ok).toBe(false);
    if (!act.ok) {
      expect(act.error.code).toBe('forbidden');
      expect(act.error.message).toContain('You cannot perform this action');
    }
  });
});
