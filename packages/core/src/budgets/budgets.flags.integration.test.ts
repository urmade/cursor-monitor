import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@nexus/db';
import {
  buildGateContext,
  checkBudget,
  createContext,
  createProject,
  createWorkItem,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('p4.budgets flag parity', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  it('with flag off launcher budget check allows and gate context has no ratios', async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p4off-${Date.now()}`,
      email: 'p4off@example.com',
      name: 'P4 Off',
    });
    orgId = u.orgId;
    userId = u.userId;

    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: {
        async isEnabled(flag: string) {
          if (flag === 'p4.budgets') return false;
          return true;
        },
      },
    });

    const project = await createProject(ctx, {
      key: testProjectKey('OF'),
      name: 'Flag off',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Item',
      complexity: 'high',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) return;

    const budget = await checkBudget(ctx, { workItemId: item.value.id });
    expect(budget.ok).toBe(true);
    if (!budget.ok) return;
    expect(budget.value.allow).toBe(true);

    const gateCtx = await buildGateContext(ctx, item.value.id);
    expect(gateCtx?.budget.itemSpentRatio).toBeNull();
    expect(gateCtx?.budget.projectSpentRatio).toBeNull();
  });
});
