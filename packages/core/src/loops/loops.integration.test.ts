import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  newId,
  runs,
  stageInstances,
  workItems,
} from '@nexus/db';
import {
  applyCostRollups,
  backfillLoopsForProject,
  createContext,
  createGate,
  createProject,
  createWorkItem,
  getLoopSummary,
  listReasonCodes,
  listStages,
  transitionWorkItem,
  updateGate,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('phase 5 loops', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `p5-${Date.now()}@example.com`,
      name: 'P5',
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

  it('requires reason on return; counts loops; never-visited backward is not a loop', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5'),
      name: 'P5 Loops',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const reasons = await listReasonCodes(c, project.value.id);
    expect(reasons.ok).toBe(true);
    if (!reasons.ok) throw new Error(reasons.error.message);
    expect(reasons.value.some((r) => r.code === 'review_findings')).toBe(true);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const intake = byKey.get('intake')!;
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Loop ticket',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);

    // Advance to review
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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

    // Return without reason — must fail
    const noReason = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: impl.id },
      version,
    );
    expect(noReason.ok).toBe(false);
    if (noReason.ok) throw new Error('expected validation failure');
    expect(noReason.error.code).toBe('validation');

    // First return with reason
    const r1 = await transitionWorkItem(
      c,
      item.value.id,
      {
        kind: 'return',
        toStageId: impl.id,
        reasonCode: 'review_findings',
        note: 'nits',
      },
      version,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error(r1.error.message);
    version = r1.value.version;
    expect(r1.value.loopCount).toBe(1);

    // Forward to review again
    const fwd = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) throw new Error(fwd.error.message);
    version = fwd.value.version;

    // Second return
    const r2 = await transitionWorkItem(
      c,
      item.value.id,
      {
        kind: 'return',
        toStageId: impl.id,
        reasonCode: 'failed_verification',
      },
      version,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error(r2.error.message);
    expect(r2.value.loopCount).toBe(2);

    const summary = await getLoopSummary(c, item.value.id);
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error(summary.error.message);
    expect(summary.value.edges).toHaveLength(2);
    expect(summary.value.edges[0]?.reasonCode).toBe('review_findings');
    expect(summary.value.edges[1]?.reasonCode).toBe('failed_verification');

    // Backward into never-visited stage (skip from impl back past plan to... wait we're at impl.
    // Move to a stage we never left via return into scoping from intake-only path:
    // Create fresh item and jump backward from scoping to a stage that was never visited
    // by inventing a stage behind intake — instead: from review go back to intake
    // after only visiting forward path — intake WAS visited, so that IS a loop.
    // True never-visited: add a stage between that we skip. Simpler: from impl,
    // we never visited deploy; going "backward" to a later stage isn't backward.
    // Use empty template? Or: reorder — skip plan on the way up, then return to plan.
    const item2 = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Skip plan',
    });
    expect(item2.ok).toBe(true);
    if (!item2.ok) throw new Error(item2.error.message);
    let v2 = item2.value.version;
    // intake → scoping → impl (skip plan)
    for (const stage of [scoping, impl]) {
      const t = await transitionWorkItem(
        c,
        item2.value.id,
        { kind: 'advance', toStageId: stage.id },
        v2,
      );
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      v2 = t.value.version;
    }
    // Backward to plan (never visited) — not a loop
    const skipBack = await transitionWorkItem(
      c,
      item2.value.id,
      { kind: 'advance', toStageId: plan.id },
      v2,
    );
    expect(skipBack.ok).toBe(true);
    if (!skipBack.ok) throw new Error(skipBack.error.message);
    expect(skipBack.value.loopCount).toBe(0);
    void intake;
  });

  it('loop budget warns at 2 and escalates at 3 without blocking', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5B'),
      name: 'P5 Budget',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const gate = await createGate(c, {
      projectId: project.value.id,
      name: 'Review→Impl loop budget',
      evaluator: 'loop_budget',
      trigger: {
        kind: 'on_transition',
        fromStageId: review.id,
        toStageId: impl.id,
      },
      config: {
        scope: 'stage_pair',
        fromStageId: review.id,
        toStageId: impl.id,
        warnAt: 2,
        escalateAt: 3,
        message: 'Too many review returns',
      },
      onFailure: 'warn',
      enabled: false,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error(gate.error.message);
    const enabled = await updateGate(c, gate.value.id, { enabled: true });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) throw new Error(enabled.error.message);

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Budget loops',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    const itemId = item.value.id;
    let version = item.value.version;

    async function toReview() {
      for (const stage of [scoping, plan, impl, review]) {
        const cur = await db.query.workItems.findFirst({
          where: eq(workItems.id, itemId),
        });
        if (cur?.currentStageId === stage.id) continue;
        const t = await transitionWorkItem(
          c,
          itemId,
          { kind: 'advance', toStageId: stage.id },
          version,
        );
        expect(t.ok).toBe(true);
        if (!t.ok) throw new Error(t.error.message);
        version = t.value.version;
      }
    }

    async function returnToImpl(reason: string) {
      const t = await transitionWorkItem(
        c,
        itemId,
        { kind: 'return', toStageId: impl.id, reasonCode: reason },
        version,
      );
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      version = t.value.version;
      return t.value;
    }

    await toReview();
    await returnToImpl('review_findings'); // 1
    await transitionWorkItem(
      c,
      itemId,
      { kind: 'advance', toStageId: review.id },
      version,
    ).then((t) => {
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      version = t.value.version;
    });

    const second = await returnToImpl('failed_verification'); // 2 — warn
    expect(second.loopCount).toBe(2);
    expect(second.loopEscalated).toBe(false);

    await transitionWorkItem(
      c,
      itemId,
      { kind: 'advance', toStageId: review.id },
      version,
    ).then((t) => {
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      version = t.value.version;
    });

    const third = await returnToImpl('agent_error'); // 3 — escalate, still workable
    expect(third.loopCount).toBe(3);
    expect(third.loopEscalated).toBe(true);

    // Still workable: can move forward
    const still = await transitionWorkItem(
      c,
      itemId,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(still.ok).toBe(true);
  });

  it('rework cost uses rollups without double-counting on reopen', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5C'),
      name: 'P5 Cost',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Cost loops',
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

    // First visit cost on impl
    const wi1 = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    const firstInstanceId = wi1!.currentStageInstanceId!;
    const run1 = newId();
    await db.insert(runs).values({
      id: run1,
      workItemId: item.value.id,
      stageInstanceId: firstInstanceId,
      adapter: 'cloud_agent',
      trigger: {},
      status: 'completed',
      nonce: `n-${run1}`,
      deadlineAt: new Date(Date.now() + 60_000),
      costMicroUsd: BigInt(1_000_000),
      costSource: 'estimated',
    });
    await applyCostRollups(db, {
      runId: run1,
      workItemId: item.value.id,
      stageInstanceId: firstInstanceId,
      projectId: project.value.id,
      deltaMicro: BigInt(1_000_000),
      costSource: 'estimated',
    });

    // To review and return
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

    const wi2 = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    const secondInstanceId = wi2!.currentStageInstanceId!;
    expect(secondInstanceId).not.toBe(firstInstanceId);

    const si2 = await db.query.stageInstances.findFirst({
      where: eq(stageInstances.id, secondInstanceId),
    });
    expect(si2?.visitIndex).toBe(2);

    const run2 = newId();
    await db.insert(runs).values({
      id: run2,
      workItemId: item.value.id,
      stageInstanceId: secondInstanceId,
      adapter: 'cloud_agent',
      trigger: {},
      status: 'completed',
      nonce: `n-${run2}`,
      deadlineAt: new Date(Date.now() + 60_000),
      costMicroUsd: BigInt(500_000),
      costSource: 'estimated',
    });
    await applyCostRollups(db, {
      runId: run2,
      workItemId: item.value.id,
      stageInstanceId: secondInstanceId,
      projectId: project.value.id,
      deltaMicro: BigInt(500_000),
      costSource: 'estimated',
    });

    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(refreshed?.spendMicroUsd).toBe(BigInt(1_500_000));
    expect(refreshed?.reworkCostMicroUsd).toBe(BigInt(500_000));

    // Applying the same rollup path again for a NEW run on the same rework
    // instance increments rework once more — but reopening creates a new
    // instance, so first-visit spend is never re-counted as rework.
    expect(refreshed?.spendMicroUsd).toBe(
      BigInt(1_000_000) + refreshed!.reworkCostMicroUsd,
    );
  });

  it('backfill is idempotent on a project with real returns (B2/B6)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5D'),
      name: 'P5 Backfill',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Backfill loops',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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
    const ret = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(ret.ok).toBe(true);
    if (!ret.ok) throw new Error(ret.error.message);
    version = ret.value.version;

    // Leave the rework visit so rework_ms has a closed interval.
    await new Promise((r) => setTimeout(r, 20));
    const fwd = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) throw new Error(fwd.error.message);

    const before = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(Number(before?.reworkMs ?? 0)).toBeGreaterThan(0);

    const a = await backfillLoopsForProject(db, project.value.id);
    const mid = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    const b = await backfillLoopsForProject(db, project.value.id);
    const after = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });

    expect(b.edgesCreated).toBe(0);
    expect(Number(after?.reworkMs)).toBe(Number(mid?.reworkMs));
    expect(Number(after?.loopCount)).toBe(Number(mid?.loopCount));
    // Deterministic ids: second run creates nothing even if dedupe guard is probed.
    expect(a.edgesCreated + b.edgesCreated).toBeLessThanOrEqual(a.edgesCreated);
  });

  it('projectReworkStats succeeds on an empty project (B1)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5E'),
      name: 'P5 Empty Stats',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const { projectReworkStats } = await import('../index');
    const stats = await projectReworkStats(c, project.value.id, 30);
    expect(stats.ok).toBe(true);
    if (!stats.ok) throw new Error(stats.error.message);
    expect(stats.value.itemCount).toBe(0);
    expect(stats.value.loopedItemCount).toBe(0);
  });

  it('loop_budget measures configured pair, not pending pair (B3)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5F'),
      name: 'P5 Scope',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    // Gate configured for plan→impl, but item will loop review→impl.
    const gate = await createGate(c, {
      projectId: project.value.id,
      name: 'Plan→Impl budget',
      evaluator: 'loop_budget',
      trigger: {
        kind: 'on_transition',
        fromStageId: review.id,
        toStageId: impl.id,
      },
      config: {
        scope: 'stage_pair',
        fromStageId: plan.id,
        toStageId: impl.id,
        warnAt: 1,
        escalateAt: 1,
        blockAt: 1,
        message: 'plan-impl only',
      },
      onFailure: 'block',
      enabled: false,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error(gate.error.message);
    await updateGate(c, gate.value.id, { enabled: true });

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Wrong pair',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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

    // review→impl: configured pair count stays 0 → must NOT block.
    const ret = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(ret.ok).toBe(true);
    if (!ret.ok) throw new Error(ret.error.message);
  });

  it('finalises edge cost from the edge stage instance, not a later visit (B4)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5G'),
      name: 'P5 Edge Cost',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Edge cost',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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

    // Return 1 → impl visit 2 with known spend
    const r1 = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error(r1.error.message);
    version = r1.value.version;
    const visit2Id = r1.value.currentStageInstanceId!;

    const runVisit2 = newId();
    await db.insert(runs).values({
      id: runVisit2,
      workItemId: item.value.id,
      stageInstanceId: visit2Id,
      adapter: 'cloud_agent',
      trigger: {},
      status: 'completed',
      nonce: `n-${runVisit2}`,
      deadlineAt: new Date(Date.now() + 60_000),
      costMicroUsd: BigInt(1_000_000),
      costSource: 'estimated',
    });
    await applyCostRollups(db, {
      runId: runVisit2,
      workItemId: item.value.id,
      stageInstanceId: visit2Id,
      projectId: project.value.id,
      deltaMicro: BigInt(1_000_000),
      costSource: 'estimated',
    });

    // Leave impl backward to plan (non-forward) — must still close the edge.
    const back = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: plan.id, reasonCode: 'spec_gap' },
      version,
    );
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.error.message);
    version = back.value.version;

    const { loopEdges } = await import('@nexus/db');
    const edge1 = await db.query.loopEdges.findFirst({
      where: eq(loopEdges.toStageInstanceId, visit2Id),
    });
    expect(edge1?.costComplete).toBe(true);
    expect(edge1?.toStageInstanceId).toBe(visit2Id);
    expect(edge1?.costMicroUsd).toBe(BigInt(1_000_000));

    // Advance to impl again (visit 3) with big spend, then leave forward.
    const toImpl = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: impl.id },
      version,
    );
    expect(toImpl.ok).toBe(true);
    if (!toImpl.ok) throw new Error(toImpl.error.message);
    version = toImpl.value.version;
    const visit3Id = toImpl.value.currentStageInstanceId!;

    await db
      .update(stageInstances)
      .set({ costMicroUsd: BigInt(9_000_000) })
      .where(eq(stageInstances.id, visit3Id));

    const leave = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(leave.ok).toBe(true);

    const edge1After = await db.query.loopEdges.findFirst({
      where: eq(loopEdges.id, edge1!.id),
    });
    // Must keep visit-2 money, not pick up visit-3.
    expect(edge1After?.costMicroUsd).toBe(BigInt(1_000_000));
  });

  it('propagates late run cost onto a closed loop edge', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5Late'),
      name: 'P5 Late Cost',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Late edge cost',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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

    const ret = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(ret.ok).toBe(true);
    if (!ret.ok) throw new Error(ret.error.message);
    version = ret.value.version;
    const reworkInstanceId = ret.value.currentStageInstanceId!;

    // Depart before the run finishes — edge closes at 0.
    const leave = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(leave.ok).toBe(true);
    if (!leave.ok) throw new Error(leave.error.message);

    const { loopEdges } = await import('@nexus/db');
    const edgeBefore = await db.query.loopEdges.findFirst({
      where: eq(loopEdges.toStageInstanceId, reworkInstanceId),
    });
    expect(edgeBefore?.costComplete).toBe(true);
    expect(edgeBefore?.costMicroUsd ?? BigInt(0)).toBe(BigInt(0));

    // Late provider-actual lands on the departed stage instance.
    const lateRun = newId();
    await db.insert(runs).values({
      id: lateRun,
      workItemId: item.value.id,
      stageInstanceId: reworkInstanceId,
      adapter: 'cloud_agent',
      trigger: {},
      status: 'completed',
      nonce: `n-${lateRun}`,
      deadlineAt: new Date(Date.now() + 60_000),
      costMicroUsd: BigInt(7_000_000),
      costSource: 'provider',
    });
    await applyCostRollups(db, {
      runId: lateRun,
      workItemId: item.value.id,
      stageInstanceId: reworkInstanceId,
      projectId: project.value.id,
      deltaMicro: BigInt(7_000_000),
      costSource: 'provider',
    });

    const edgeAfter = await db.query.loopEdges.findFirst({
      where: eq(loopEdges.id, edgeBefore!.id),
    });
    expect(edgeAfter?.costMicroUsd).toBe(BigInt(7_000_000));

    const wi = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(wi?.reworkCostMicroUsd).toBe(BigInt(7_000_000));
    expect(wi?.spendMicroUsd).toBe(BigInt(7_000_000));
  });

  it('concurrent returns do not commit phantom loop history (B5)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5H'),
      name: 'P5 Concurrent',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Concurrent',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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

    const results = await Promise.all([
      transitionWorkItem(
        c,
        item.value.id,
        { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
        version,
      ),
      transitionWorkItem(
        c,
        item.value.id,
        { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
        version,
      ),
      transitionWorkItem(
        c,
        item.value.id,
        { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
        version,
      ),
    ]);

    const okCount = results.filter((r) => r.ok).length;
    const staleCount = results.filter(
      (r) => !r.ok && r.error.code === 'stale_version',
    ).length;
    expect(okCount).toBe(1);
    expect(staleCount).toBe(2);

    const { loopEdges } = await import('@nexus/db');
    const edges = await db.query.loopEdges.findMany({
      where: eq(loopEdges.workItemId, item.value.id),
    });
    expect(edges).toHaveLength(1);

    const wi = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(wi?.loopCount).toBe(1);

    const instances = await db.query.stageInstances.findMany({
      where: eq(stageInstances.workItemId, item.value.id),
    });
    const open = instances.filter((i) => i.exitedAt == null);
    expect(open).toHaveLength(1);
  });

  it('clears escalation on forward and catches warnAt boundary (B6)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5I'),
      name: 'P5 Escalate clear',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const gate = await createGate(c, {
      projectId: project.value.id,
      name: 'Item loop budget',
      evaluator: 'loop_budget',
      trigger: { kind: 'on_transition', fromStageId: review.id, toStageId: impl.id },
      config: {
        scope: 'item',
        warnAt: 2,
        escalateAt: 3,
        message: 'item loops',
      },
      onFailure: 'warn',
      enabled: false,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error(gate.error.message);
    await updateGate(c, gate.value.id, { enabled: true });

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Esc clear',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    const itemId = item.value.id;
    let version = item.value.version;

    async function toReview() {
      for (const stage of [scoping, plan, impl, review]) {
        const cur = await db.query.workItems.findFirst({
          where: eq(workItems.id, itemId),
        });
        if (cur?.currentStageId === stage.id) continue;
        const t = await transitionWorkItem(
          c,
          itemId,
          { kind: 'advance', toStageId: stage.id },
          version,
        );
        expect(t.ok).toBe(true);
        if (!t.ok) throw new Error(t.error.message);
        version = t.value.version;
      }
    }

    await toReview();
    for (let i = 0; i < 3; i++) {
      const t = await transitionWorkItem(
        c,
        itemId,
        { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
        version,
      );
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      version = t.value.version;
      if (i < 2) {
        const fwd = await transitionWorkItem(
          c,
          itemId,
          { kind: 'advance', toStageId: review.id },
          version,
        );
        expect(fwd.ok).toBe(true);
        if (!fwd.ok) throw new Error(fwd.error.message);
        version = fwd.value.version;
      }
    }

    const escalated = await db.query.workItems.findFirst({
      where: eq(workItems.id, itemId),
    });
    expect(escalated?.loopEscalated).toBe(true);
    expect(escalated?.loopCount).toBe(3);

    const fwd = await transitionWorkItem(
      c,
      itemId,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) throw new Error(fwd.error.message);
    expect(fwd.value.loopEscalated).toBe(false);
  });

  it('keeps escalation on backward moves that do not re-trip the gate (M08)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5M08'),
      name: 'P5 Esc Persist',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const gate = await createGate(c, {
      projectId: project.value.id,
      name: 'Review→Impl only',
      evaluator: 'loop_budget',
      trigger: {
        kind: 'on_transition',
        fromStageId: review.id,
        toStageId: impl.id,
      },
      config: {
        scope: 'stage_pair',
        fromStageId: review.id,
        toStageId: impl.id,
        warnAt: 2,
        escalateAt: 3,
        message: 'pair only',
      },
      onFailure: 'warn',
      enabled: false,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error(gate.error.message);
    await updateGate(c, gate.value.id, { enabled: true });

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Esc persist',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    const itemId = item.value.id;
    let version = item.value.version;

    for (const stage of [scoping, plan, impl, review]) {
      const t = await transitionWorkItem(
        c,
        itemId,
        { kind: 'advance', toStageId: stage.id },
        version,
      );
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      version = t.value.version;
    }

    for (let i = 0; i < 3; i++) {
      const t = await transitionWorkItem(
        c,
        itemId,
        { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
        version,
      );
      expect(t.ok).toBe(true);
      if (!t.ok) throw new Error(t.error.message);
      version = t.value.version;
      if (i < 2) {
        const fwd = await transitionWorkItem(
          c,
          itemId,
          { kind: 'advance', toStageId: review.id },
          version,
        );
        expect(fwd.ok).toBe(true);
        if (!fwd.ok) throw new Error(fwd.error.message);
        version = fwd.value.version;
      }
    }

    const escalated = await db.query.workItems.findFirst({
      where: eq(workItems.id, itemId),
    });
    expect(escalated?.loopEscalated).toBe(true);
    // Now at impl after third return. Backward to plan — not the gated pair.
    const back = await transitionWorkItem(
      c,
      itemId,
      { kind: 'return', toStageId: plan.id, reasonCode: 'spec_gap' },
      version,
    );
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value.loopEscalated).toBe(true);
  });

  it('projectReworkStats returns real numbers on a populated project', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5Stats'),
      name: 'P5 Stats Pop',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Stats item',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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
    const ret = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(ret.ok).toBe(true);
    if (!ret.ok) throw new Error(ret.error.message);

    const { projectReworkStats } = await import('../index');
    const stats = await projectReworkStats(c, project.value.id, 30);
    expect(stats.ok).toBe(true);
    if (!stats.ok) throw new Error(stats.error.message);
    expect(stats.value.itemCount).toBe(1);
    expect(stats.value.loopedItemCount).toBe(1);
    expect(stats.value.reworkRate).toBe(1);
    expect(stats.value.meanLoopsWhenLooped).toBe(1);
    expect(stats.value.topStagePairs.length).toBeGreaterThanOrEqual(1);
    expect(stats.value.topStagePairs[0]?.returnCount).toBe(1);
  });

  it('rework_ms is absolute and idempotent across backfill (B2)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5J'),
      name: 'P5 Rework Ms',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Rework ms',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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

    const ret = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(ret.ok).toBe(true);
    if (!ret.ok) throw new Error(ret.error.message);
    version = ret.value.version;

    // Still in open rework visit — rework_ms must be 0 (closed visits only).
    const open = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(Number(open?.reworkMs ?? -1)).toBe(0);

    await new Promise((r) => setTimeout(r, 30));
    const leave = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'advance', toStageId: review.id },
      version,
    );
    expect(leave.ok).toBe(true);
    if (!leave.ok) throw new Error(leave.error.message);

    const closed = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    const ms1 = Number(closed?.reworkMs ?? 0);
    expect(ms1).toBeGreaterThan(0);

    await backfillLoopsForProject(db, project.value.id);
    const after1 = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    await backfillLoopsForProject(db, project.value.id);
    const after2 = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(Number(after1?.reworkMs)).toBe(ms1);
    expect(Number(after2?.reworkMs)).toBe(ms1);
  });

  it('backfill edge ids are deterministic (catches md5→random mutation)', async () => {
    const c = ctx();
    const project = await createProject(c, {
      key: testProjectKey('P5K'),
      name: 'P5 Det Id',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const stages = await listStages(c, project.value.id);
    expect(stages.ok).toBe(true);
    if (!stages.ok) throw new Error(stages.error.message);
    const byKey = new Map(stages.value.map((s) => [s.key, s]));
    const scoping = byKey.get('scoping')!;
    const plan = byKey.get('plan')!;
    const impl = byKey.get('implementation')!;
    const review = byKey.get('review')!;

    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'Det id',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);
    let version = item.value.version;
    for (const stage of [scoping, plan, impl, review]) {
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
    const ret = await transitionWorkItem(
      c,
      item.value.id,
      { kind: 'return', toStageId: impl.id, reasonCode: 'review_findings' },
      version,
    );
    expect(ret.ok).toBe(true);
    if (!ret.ok) throw new Error(ret.error.message);

    const { loopEdges, transitions } = await import('@nexus/db');
    const existing = await db.query.loopEdges.findMany({
      where: eq(loopEdges.workItemId, item.value.id),
    });
    expect(existing).toHaveLength(1);
    const transitionId = existing[0]!.transitionId;

    await db.delete(loopEdges).where(eq(loopEdges.workItemId, item.value.id));
    await db
      .update(transitions)
      .set({ loopEdgeId: null })
      .where(eq(transitions.id, transitionId));

    const first = await backfillLoopsForProject(db, project.value.id);
    expect(first.edgesCreated).toBe(1);
    const afterFirst = await db.query.loopEdges.findMany({
      where: eq(loopEdges.workItemId, item.value.id),
    });
    const id1 = afterFirst[0]!.id;

    await db.delete(loopEdges).where(eq(loopEdges.workItemId, item.value.id));
    await db
      .update(transitions)
      .set({ loopEdgeId: null })
      .where(eq(transitions.id, transitionId));

    const second = await backfillLoopsForProject(db, project.value.id);
    expect(second.edgesCreated).toBe(1);
    const afterSecond = await db.query.loopEdges.findMany({
      where: eq(loopEdges.workItemId, item.value.id),
    });
    expect(afterSecond[0]!.id).toBe(id1);

    const { sql } = await import('drizzle-orm');
    const expected = await db.execute<{ id: string }>(
      sql`select md5(${transitionId}::text || ':loop_edge')::uuid as id`,
    );
    const expectedId = (expected as unknown as Array<{ id: string }>)[0]?.id;
    expect(id1).toBe(expectedId);
  });
});
