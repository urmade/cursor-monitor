import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  loopEdges,
  newId,
  runs,
  stageInstances,
  workItems,
} from '@nexus/db';
import {
  applyCostRollups,
  createContext,
  createProject,
  createWorkItem,
  listStages,
  transitionWorkItem,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

/**
 * Independent oracle: count returns from stage history + positions without
 * calling production `isReturnEdge`. Hard-wiring that helper to true/false
 * must diverge `work_items.loop_count` / `loop_edges` from this count.
 */
function expectedReturnCount(
  history: Array<{ stageId: string; seq: number }>,
  positionById: Map<string, number>,
): number {
  let count = 0;
  const visits = new Map<string, number>();
  let prevStageId: string | null = null;
  const ordered = [...history].sort((a, b) => a.seq - b.seq);
  for (const row of ordered) {
    const prior = visits.get(row.stageId) ?? 0;
    if (prevStageId != null) {
      const fromPos = positionById.get(prevStageId);
      const toPos = positionById.get(row.stageId);
      if (fromPos != null && toPos != null) {
        const direction =
          toPos > fromPos ? 'forward' : toPos < fromPos ? 'backward' : 'lateral';
        if (direction === 'backward' && prior > 0) count += 1;
      }
    }
    visits.set(row.stageId, prior + 1);
    prevStageId = row.stageId;
  }
  return count;
}

describe.runIf(hasDb)('loop properties (DB-backed)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p5-prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `p5-prop-${Date.now()}@example.com`,
      name: 'P5 Prop',
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
        async isEnabled(key: string) {
          return (
            key === 'p5.loops' ||
            key === 'p3.gates' ||
            key === 'p4.budgets' ||
            key.startsWith('p')
          );
        },
      },
    });
  }

  it('loop_count and edge rows match an independent history oracle', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5Prop'),
      name: 'P5 Prop loops',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stageList = await listStages(c, project.value.id);
    expect(stageList.ok).toBe(true);
    if (!stageList.ok) throw new Error(stageList.error.message);
    const orderedStages = [...stageList.value].sort(
      (a, b) => a.position - b.position,
    );
    // Use a subset so random walks stay in-pipeline.
    const pipeline = orderedStages.filter((s) =>
      ['intake', 'scoping', 'plan', 'implementation', 'review'].includes(s.key),
    );
    expect(pipeline.length).toBeGreaterThanOrEqual(4);
    const positionById = new Map(pipeline.map((s) => [s.id, s.position]));

    let sawZero = false;
    let sawPositive = false;

    // Deterministic forward-only item — oracle and counters must be zero.
    {
      const item = await createWorkItem(c, {
        projectId: project.value.id,
        title: 'prop-forward-only',
      });
      expect(item.ok).toBe(true);
      if (!item.ok) throw new Error(item.error.message);
      let version = item.value.version;
      for (const stage of pipeline.slice(1, 4)) {
        const t = await transitionWorkItem(
          c,
          item.value.id,
          { kind: 'advance', toStageId: stage.id },
          version,
        );
        expect(t.ok).toBe(true);
        if (!t.ok) throw new Error(t.error.message);
        version = t.value.version;
      }
      const history = await db.query.stageInstances.findMany({
        where: eq(stageInstances.workItemId, item.value.id),
        orderBy: [asc(stageInstances.seq)],
      });
      const expected = expectedReturnCount(
        history.map((h) => ({ stageId: h.stageId, seq: h.seq })),
        positionById,
      );
      const wi = await db.query.workItems.findFirst({
        where: eq(workItems.id, item.value.id),
      });
      const edges = await db.query.loopEdges.findMany({
        where: eq(loopEdges.workItemId, item.value.id),
      });
      expect(expected).toBe(0);
      expect(wi?.loopCount).toBe(0);
      expect(edges).toHaveLength(0);
      sawZero = true;
    }

    for (let seed = 0; seed < 12; seed++) {
      const item = await createWorkItem(c, {
        projectId: project.value.id,
        title: `prop-${seed}`,
      });
      expect(item.ok).toBe(true);
      if (!item.ok) throw new Error(item.error.message);
      let version = item.value.version;
      let currentIdx = 0; // intake

      let x = seed * 1103515245 + 12345;
      for (let step = 0; step < 10; step++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const nextIdx = x % pipeline.length;
        if (nextIdx === currentIdx) continue;
        const to = pipeline[nextIdx]!;
        const goingBack = nextIdx < currentIdx;
        const t = await transitionWorkItem(
          c,
          item.value.id,
          goingBack
            ? {
                kind: 'return',
                toStageId: to.id,
                reasonCode: 'review_findings',
              }
            : { kind: 'advance', toStageId: to.id },
          version,
        );
        // Some backward moves into never-visited stages are advances; allow both.
        if (!t.ok && t.error.code === 'validation') {
          const retry = await transitionWorkItem(
            c,
            item.value.id,
            {
              kind: 'return',
              toStageId: to.id,
              reasonCode: 'human_direction',
            },
            version,
          );
          if (!retry.ok) continue;
          version = retry.value.version;
          currentIdx = nextIdx;
          continue;
        }
        if (!t.ok) continue;
        version = t.value.version;
        currentIdx = nextIdx;
      }

      const history = await db.query.stageInstances.findMany({
        where: eq(stageInstances.workItemId, item.value.id),
        orderBy: [asc(stageInstances.seq)],
      });
      const expected = expectedReturnCount(
        history.map((h) => ({ stageId: h.stageId, seq: h.seq })),
        positionById,
      );

      const wi = await db.query.workItems.findFirst({
        where: eq(workItems.id, item.value.id),
      });
      const edges = await db.query.loopEdges.findMany({
        where: eq(loopEdges.workItemId, item.value.id),
      });

      expect(wi?.loopCount).toBe(expected);
      expect(edges.length).toBe(expected);
      // Independent counters must agree with each other too.
      expect(wi?.loopCount).toBe(edges.length);

      if (expected === 0) sawZero = true;
      if (expected > 0) sawPositive = true;
    }

    expect(sawZero).toBe(true);
    expect(sawPositive).toBe(true);
  }, 60_000);

  it('rework cost never exceeds total spend after real applyCostRollups', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5PropC'),
      name: 'P5 Prop cost',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stageList = await listStages(c, project.value.id);
    expect(stageList.ok).toBe(true);
    if (!stageList.ok) throw new Error(stageList.error.message);
    const byKey = new Map(stageList.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    for (let seed = 0; seed < 8; seed++) {
      const item = await createWorkItem(c, {
        projectId: project.value.id,
        title: `cost-${seed}`,
      });
      expect(item.ok).toBe(true);
      if (!item.ok) throw new Error(item.error.message);
      let version = item.value.version;

      for (const stage of [scoping, plan, impl]) {
        const t = await transitionWorkItem(
          c,
          item.value.id,
          { kind: 'advance', toStageId: stage.id },
          version,
        );
        expect(t.ok).toBe(true);
        if (!t.ok) throw new Error(t.error.message);
        version = t.value.version;
      }

      const firstVisitId = (
        await db.query.workItems.findFirst({
          where: eq(workItems.id, item.value.id),
        })
      )!.currentStageInstanceId!;

      const firstCost = BigInt(500_000 + seed * 100_000);
      const run1 = newId();
      await db.insert(runs).values({
        id: run1,
        workItemId: item.value.id,
        stageInstanceId: firstVisitId,
        adapter: 'cloud_agent',
        trigger: {},
        status: 'completed',
        nonce: `n-${run1}`,
        deadlineAt: new Date(Date.now() + 60_000),
        costMicroUsd: firstCost,
        costSource: 'estimated',
      });
      await applyCostRollups(db, {
        runId: run1,
        workItemId: item.value.id,
        stageInstanceId: firstVisitId,
        projectId: project.value.id,
        deltaMicro: firstCost,
        costSource: 'estimated',
      });

      const toRev = await transitionWorkItem(
        c,
        item.value.id,
        { kind: 'advance', toStageId: review.id },
        version,
      );
      expect(toRev.ok).toBe(true);
      if (!toRev.ok) throw new Error(toRev.error.message);
      version = toRev.value.version;

      const ret = await transitionWorkItem(
        c,
        item.value.id,
        {
          kind: 'return',
          toStageId: impl.id,
          reasonCode: 'review_findings',
        },
        version,
      );
      expect(ret.ok).toBe(true);
      if (!ret.ok) throw new Error(ret.error.message);
      version = ret.value.version;
      const reworkVisitId = ret.value.currentStageInstanceId!;

      const reworkCost = BigInt(200_000 + seed * 50_000);
      const run2 = newId();
      await db.insert(runs).values({
        id: run2,
        workItemId: item.value.id,
        stageInstanceId: reworkVisitId,
        adapter: 'cloud_agent',
        trigger: {},
        status: 'completed',
        nonce: `n-${run2}`,
        deadlineAt: new Date(Date.now() + 60_000),
        costMicroUsd: reworkCost,
        costSource: 'estimated',
      });
      await applyCostRollups(db, {
        runId: run2,
        workItemId: item.value.id,
        stageInstanceId: reworkVisitId,
        projectId: project.value.id,
        deltaMicro: reworkCost,
        costSource: 'estimated',
      });

      const wi = await db.query.workItems.findFirst({
        where: eq(workItems.id, item.value.id),
      });
      expect(wi).toBeTruthy();
      expect(wi!.reworkCostMicroUsd).toBeLessThanOrEqual(wi!.spendMicroUsd);
      expect(wi!.reworkCostMicroUsd).toBe(reworkCost);
      expect(wi!.spendMicroUsd).toBe(firstCost + reworkCost);
    }
  }, 60_000);
});
