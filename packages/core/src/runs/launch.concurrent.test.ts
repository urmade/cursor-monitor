import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDb, getDb, projects, runs, stages, workItems } from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  launchRun,
  updateProject,
  upsertBinding,
  upsertUserFromPassport,
} from '../index';
import { fromUsd } from '../cost/money';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('launchRun burn-cap concurrency (B6)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);

  afterAll(async () => {
    await closeDb();
  });

  async function setupProject() {
    const u = await upsertUserFromPassport(db, {
      externalSub: `b6-${Date.now()}`,
      email: `b6-${Date.now()}@example.com`,
      name: 'B6',
    });

    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: {
        async isEnabled(flag: string) {
          return flag === 'p4.budgets' || flag.startsWith('p2.') || flag === 'orchestration.enabled';
        },
      },
    });

    const project = await createProject(ctx, {
      key: testProjectKey('B6'),
      name: 'B6 burn race',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project');

    const cap = fromUsd(11);
    const reserve = fromUsd(2);
    const committed = fromUsd(8);

    await updateProject(ctx, project.value.id, {
      settings: {
        concurrentRunCeiling: 10,
        dailyRunCap: 100,
        budget: {
          burnCapMicroUsd: cap.toString(),
          reserveMicroUsdPerRun: reserve.toString(),
          blockOnBurnCap: true,
          complexityDefaults: {
            low: { softMicroUsd: '0', hardMicroUsd: '0' },
            medium: { softMicroUsd: '0', hardMicroUsd: '0' },
            high: { softMicroUsd: '0', hardMicroUsd: '0' },
          },
        },
      },
    });

    await db
      .update(projects)
      .set({ spendMicroUsd: committed })
      .where(eq(projects.id, project.value.id));

    const stage = await db.query.stages.findFirst({
      where: and(
        eq(stages.projectId, project.value.id),
        isNull(stages.archivedAt),
      ),
    });
    if (!stage) throw new Error('stage');

    const binding = await upsertBinding(ctx, {
      projectId: project.value.id,
      stageId: stage.id,
      name: 'B6 binding',
      adapter: 'cloud_agent',
      config: { adapter: 'cloud_agent', noRepo: true, maxDurationMinutes: 5 },
      enabled: true,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error('binding');

    const itemA = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Item A',
    });
    const itemB = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Item B',
    });
    expect(itemA.ok && itemB.ok).toBe(true);
    if (!itemA.ok || !itemB.ok) throw new Error('items');

    return {
      ctx,
      projectId: project.value.id,
      bindingId: binding.value.id,
      itemAId: itemA.value.id,
      itemBId: itemB.value.id,
    };
  }

  it('allows only one concurrent launch when combined reservations breach burn cap', async () => {
    const { ctx, projectId, bindingId, itemAId, itemBId } = await setupProject();

    const [a, b] = await Promise.all([
      launchRun(ctx, {
        workItemId: itemAId,
        bindingId,
        _testStopAfterPersist: true,
      }),
      launchRun(ctx, {
        workItemId: itemBId,
        bindingId,
        _testStopAfterPersist: true,
      }),
    ]);

    const budgetBurn = [a, b].filter(
      (r) => !r.ok && r.error.code === 'budget_burn',
    );
    const succeeded = [a, b].filter((r) => r.ok);
    expect(budgetBurn).toHaveLength(1);
    expect(succeeded).toHaveLength(1);

    const runRows = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .where(eq(workItems.projectId, projectId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe('pending');
  });
});
