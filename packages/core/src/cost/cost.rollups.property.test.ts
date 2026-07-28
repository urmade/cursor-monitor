import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, newId, projects, runs, stageInstances, workItems } from '@nexus/db';
import type { CostSource } from '@nexus/db';
import {
  applyCostRollups,
  createContext,
  createProject,
  createWorkItem,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from './test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

const SOURCES: CostSource[] = ['estimated', 'provider', 'admin_reconciled'];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe.runIf(hasDb)('cost rollup property', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p4-prop-${Date.now()}`,
      email: 'p4-prop@example.com',
      name: 'P4 Prop',
    });
    orgId = u.orgId;
    userId = u.userId;
  });

  it('item and project spend equal sum of run costs after random apply order', async () => {
    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { async isEnabled() { return true; } },
    });

    for (let trial = 0; trial < 5; trial += 1) {
      const project = await createProject(ctx, {
        key: testProjectKey('PR'),
        name: `Prop ${trial}`,
        template: 'default',
      });
      expect(project.ok).toBe(true);
      if (!project.ok) throw new Error(project.error.message);

      const itemA = await createWorkItem(ctx, {
        projectId: project.value.id,
        title: 'A',
      });
      const itemB = await createWorkItem(ctx, {
        projectId: project.value.id,
        title: 'B',
      });
      expect(itemA.ok && itemB.ok).toBe(true);
      if (!itemA.ok) throw new Error(itemA.error.message);
      if (!itemB.ok) throw new Error(itemB.error.message);

      const wiA = await db.query.workItems.findFirst({
        where: eq(workItems.id, itemA.value.id),
      });
      const wiB = await db.query.workItems.findFirst({
        where: eq(workItems.id, itemB.value.id),
      });
      const stageA = wiA!.currentStageInstanceId!;
      const stageB = wiB!.currentStageInstanceId!;

      const runCount = 8 + Math.floor(Math.random() * 12);
      const planned: Array<{
        runId: string;
        workItemId: string;
        stageInstanceId: string;
        delta: bigint;
        source: CostSource;
      }> = [];

      let expectedA = BigInt(0);
      let expectedB = BigInt(0);
      let expectedProject = BigInt(0);

      for (let i = 0; i < runCount; i += 1) {
        const onA = i % 2 === 0;
        const workItemId = onA ? itemA.value.id : itemB.value.id;
        const stageInstanceId = onA ? stageA : stageB;
        const delta = BigInt(100 + Math.floor(Math.random() * 50_000));
        const source = SOURCES[i % SOURCES.length]!;
        if (onA) expectedA += delta;
        else expectedB += delta;
        expectedProject += delta;

        const runId = newId();
        planned.push({ runId, workItemId, stageInstanceId, delta, source });
      }

      for (const step of shuffle(planned)) {
        await db.insert(runs).values({
          id: step.runId,
          workItemId: step.workItemId,
          stageInstanceId: step.stageInstanceId,
          adapter: 'cloud_agent',
          trigger: {},
          status: 'completed',
          nonce: `prop-${step.runId}`,
          deadlineAt: new Date(Date.now() + 60_000),
          costMicroUsd: step.delta,
          costSource: step.source,
        });
        await applyCostRollups(db, {
          runId: step.runId,
          workItemId: step.workItemId,
          stageInstanceId: step.stageInstanceId,
          projectId: project.value.id,
          deltaMicro: step.delta,
          costSource: step.source,
        });
      }

      const sumRows = await db.execute(sql`
        select coalesce(sum(cost_micro_usd), 0)::bigint as total
        from runs r
        join work_items w on w.id = r.work_item_id
        where w.project_id = ${project.value.id}
          and r.status = 'completed'
      `);
      const sumArr = sumRows as unknown as Array<{ total: bigint }>;
      const runSum = BigInt(sumArr[0]?.total ?? 0);
      expect(runSum).toBe(expectedProject);

      const rowA = await db.query.workItems.findFirst({
        where: eq(workItems.id, itemA.value.id),
      });
      const rowB = await db.query.workItems.findFirst({
        where: eq(workItems.id, itemB.value.id),
      });
      const rowP = await db.query.projects.findFirst({
        where: eq(projects.id, project.value.id),
      });

      expect(rowA?.spendMicroUsd).toBe(expectedA);
      expect(rowB?.spendMicroUsd).toBe(expectedB);
      expect(rowP?.spendMicroUsd).toBe(expectedProject);
      expect(rowP?.spendMicroUsd).toBe(runSum);

      const stageRow = await db.query.stageInstances.findFirst({
        where: eq(stageInstances.id, stageA),
      });
      expect(stageRow?.costMicroUsd).toBe(expectedA);
    }
  });
});
