import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  estimateCache,
  getDb,
  newId,
  orgs,
  stages,
  users,
  workItems,
} from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  estimateForNewItem,
  invalidateEstimateCacheForProject,
  latestBacktest,
  runBacktest,
  computeDaily,
  projectAnalytics,
  transitionWorkItem,
  upsertUserFromPassport,
} from '../index';
import { cacheKey } from './math';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('phase 9 estimates + analytics integration', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let ownerId = '';
  let ctx: ReturnType<typeof createContext>;

  beforeAll(async () => {
    const owner = await upsertUserFromPassport(db, {
      externalSub: `p9-owner-${Date.now()}`,
      email: 'p9-owner@example.com',
      name: 'P9 Owner',
    });
    orgId = owner.orgId;
    ownerId = owner.userId;
    ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: ownerId },
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('returns cold start with three completed items and a range after five', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    // Unique pipeline fingerprint so org-wide tier 3 cannot borrow other projects' history.
    const project = await createProject(ctx, {
      key: `E${suffix}`,
      name: 'Estimate Proj',
      template: 'empty',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const { addStage, upsertLabel } = await import('../projects');
    const backlog = await addStage(ctx, {
      projectId: project.value.id,
      key: `est_backlog_${suffix}`,
      name: 'Backlog',
      position: 0,
      defaultOwnerClass: 'human',
      isInitial: true,
      isTerminal: false,
    });
    const done = await addStage(ctx, {
      projectId: project.value.id,
      key: `est_done_${suffix}`,
      name: 'Done',
      position: 1,
      defaultOwnerClass: 'human',
      isInitial: false,
      isTerminal: true,
    });
    expect(backlog.ok && done.ok).toBe(true);
    if (!backlog.ok || !done.ok) return;

    await upsertLabel(ctx, {
      projectId: project.value.id,
      key: 'surface:api',
      name: 'API',
      color: 'slate',
      category: 'surface',
      agentSettable: true,
    });

    const terminal = done.value.find((s) => s.isTerminal);
    expect(terminal).toBeTruthy();
    if (!terminal) return;

    // Seed three completed High items — must cold-start.
    for (let i = 0; i < 3; i++) {
      const item = await createWorkItem(ctx, {
        projectId: project.value.id,
        title: `seed-${i}`,
        complexity: 'high',
        labelKeys: ['surface:api'],
      });
      expect(item.ok).toBe(true);
      if (!item.ok) return;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: BigInt((i + 1) * 10_000_000),
          spendSource: 'provider',
          currentStageId: terminal!.id,
          updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
        })
        .where(eq(workItems.id, item.value.id));
    }

    const cold = await estimateForNewItem(ctx, {
      projectId: project.value.id,
      complexity: 'high',
      labelKeys: ['surface:api'],
      bypassCache: true,
    });
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;
    expect(cold.value.kind).toBe('cold_start');
    if (cold.value.kind === 'cold_start') {
      expect(cold.value.basis).toMatch(/only 3 comparable/i);
      expect(cold.value.n).toBe(3);
    }

    // Add two more → tier 1/2 range.
    for (let i = 3; i < 5; i++) {
      const item = await createWorkItem(ctx, {
        projectId: project.value.id,
        title: `seed-${i}`,
        complexity: 'high',
        labelKeys: ['surface:api'],
      });
      expect(item.ok).toBe(true);
      if (!item.ok) return;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: BigInt((i + 1) * 10_000_000),
          spendSource: 'estimated',
          currentStageId: terminal!.id,
          updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
        })
        .where(eq(workItems.id, item.value.id));
    }

    await invalidateEstimateCacheForProject(ctx, project.value.id);

    const ranged = await estimateForNewItem(ctx, {
      projectId: project.value.id,
      complexity: 'high',
      labelKeys: ['surface:api'],
      bypassCache: true,
    });
    expect(ranged.ok).toBe(true);
    if (!ranged.ok) return;
    expect(ranged.value.kind).toBe('range');
    if (ranged.value.kind === 'range') {
      expect(ranged.value.n).toBeGreaterThanOrEqual(5);
      expect(ranged.value.basis).toMatch(/Estimate Proj|similar High/i);
      expect(BigInt(ranged.value.lowMicroUsd)).toBeLessThanOrEqual(
        BigInt(ranged.value.p90MicroUsd),
      );
    }

    // Snapshot on create
    const created = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'with snapshot',
      complexity: 'high',
      labelKeys: ['surface:api'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await db.query.workItems.findFirst({
      where: eq(workItems.id, created.value.id),
    });
    expect(row?.estimateAtCreation).toBeTruthy();
    expect(row?.estimateTier).toBeGreaterThanOrEqual(1);
  });

  it('backtest can report a bad result (low coverage)', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    // Unique pipeline so org-wide tier 3 cannot borrow other tests' history.
    const project = await createProject(ctx, {
      key: `B${suffix}`,
      name: 'Backtest Proj',
      template: 'empty',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const { addStage } = await import('../projects');
    const backlog = await addStage(ctx, {
      projectId: project.value.id,
      key: `bt_backlog_${suffix}`,
      name: 'Backlog',
      position: 0,
      defaultOwnerClass: 'human',
      isInitial: true,
      isTerminal: false,
    });
    const done = await addStage(ctx, {
      projectId: project.value.id,
      key: `bt_done_${suffix}`,
      name: 'Done',
      position: 1,
      defaultOwnerClass: 'human',
      isInitial: false,
      isTerminal: true,
    });
    expect(backlog.ok && done.ok).toBe(true);
    if (!backlog.ok || !done.ok) return;
    const terminal = done.value.find((s) => s.isTerminal);
    expect(terminal).toBeTruthy();
    if (!terminal) return;

    // Point-mass history then a few hostile actuals: p10–p90 collapses to the
    // mass, so walk-forward coverage is honestly bad (B6).
    for (let i = 0; i < 8; i++) {
      const item = await createWorkItem(ctx, {
        projectId: project.value.id,
        title: `bt-${i}`,
        complexity: 'medium',
      });
      if (!item.ok) continue;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: i < 5 ? 5_000_000n : 100_000_000n,
          spendSource: 'provider',
          currentStageId: terminal.id,
          updatedAt: new Date(Date.UTC(2026, 2, i + 1)),
        })
        .where(eq(workItems.id, item.value.id));
    }

    const result = await runBacktest(ctx, { projectId: project.value.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sampleSize).toBeGreaterThan(0);
    // B6: must actually report bad news — not tautologies on typeof/≤1.
    expect(result.value.coverage).toBeLessThan(0.65);
    expect(result.value.interpretation).toMatch(
      /too narrow|narrow|over-prediction|run high|run low/i,
    );
    expect(result.value.mape == null || result.value.mape > 0).toBe(true);
    expect(result.value.p50Bias == null || result.value.p50Bias !== 1).toBe(true);

    // M29: latestBacktest must return the persisted coverage, not a hardcoded 0.80
    const latest = await latestBacktest(ctx, { projectId: project.value.id });
    expect(latest.ok).toBe(true);
    if (!latest.ok || !latest.value) return;
    expect(latest.value.coverage).toBeCloseTo(result.value.coverage, 2);
    expect(latest.value.coverage).toBeLessThan(0.65);
    expect(latest.value.coverage).not.toBe(0.8);
  });

  it('analytics reconcile with source work_items spend', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const project = await createProject(ctx, {
      key: `A${suffix}`,
      name: 'Analytics Proj',
      template: 'minimal',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const terminal = await db.query.stages.findFirst({
      where: and(
        eq(stages.projectId, project.value.id),
        eq(stages.isTerminal, true),
        isNull(stages.archivedAt),
      ),
    });

    const spends = [2_000_000n, 4_000_000n, 6_000_000n];
    for (let i = 0; i < spends.length; i++) {
      const item = await createWorkItem(ctx, {
        projectId: project.value.id,
        title: `an-${i}`,
        complexity: 'low',
      });
      if (!item.ok) continue;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: spends[i]!,
          budgetMicroUsd: 5_000_000n,
          loopCount: i === 2 ? 1 : 0,
          reworkCostMicroUsd: i === 2 ? 1_000_000n : 0n,
          currentStageId: terminal!.id,
        })
        .where(eq(workItems.id, item.value.id));
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const summary = await projectAnalytics(ctx, project.value.id, { from, to });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;

    // Hand query: median of 2,4,6 = 4
    expect(summary.value.costPerItem.medianMicroUsd).toBe('4000000');
    expect(summary.value.spendVersusBudget.overrunCount).toBe(1);
    expect(summary.value.rework.itemsWithLoops).toBe(1);
    expect(summary.value.rework.itemCount).toBe(3);
    // B5: zero-touch items count — all three have 0 interventions → median 0.
    expect(summary.value.humanTouches.medianPerItem).toBe(0);
    expect(summary.value.humanTouches.meanPerItem).toBe(0);

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const daily = await computeDaily(ctx, yesterday);
    expect(daily.ok).toBe(true);

    const todayRejected = await computeDaily(ctx, new Date());
    expect(todayRejected.ok).toBe(false);
  });

  it('denies analytics to non-members with not_found (M22)', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const project = await createProject(ctx, {
      key: `AN${suffix}`,
      name: 'Authz Analytics',
      template: 'minimal',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const stranger = await upsertUserFromPassport(db, {
      externalSub: `p9-analytics-stranger-${Date.now()}`,
      email: 'astranger@example.com',
      name: 'AStranger',
    });
    const strangerCtx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: stranger.userId },
    });
    const denied = await projectAnalytics(strangerCtx, project.value.id, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('not_found');
  });

  it('does not leak estimates across organisations (B1)', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const victim = await upsertUserFromPassport(db, {
      externalSub: `p9-victim-${Date.now()}`,
      email: 'victim@example.com',
      name: 'Victim Co',
    });
    const victimOrgId = newId();
    await db.insert(orgs).values({
      id: victimOrgId,
      name: 'Victim Co',
      slug: `victim-${suffix.toLowerCase()}`,
    });
    await db.update(users).set({ orgId: victimOrgId }).where(eq(users.id, victim.userId));

    const attackerProject = await createProject(ctx, {
      key: `ATK${suffix}`,
      name: 'Attacker Proj',
      template: 'minimal',
    });
    expect(attackerProject.ok).toBe(true);
    if (!attackerProject.ok) return;

    const terminal = await db.query.stages.findFirst({
      where: and(
        eq(stages.projectId, attackerProject.value.id),
        eq(stages.isTerminal, true),
        isNull(stages.archivedAt),
      ),
    });
    for (let i = 0; i < 8; i++) {
      const item = await createWorkItem(ctx, {
        projectId: attackerProject.value.id,
        title: `atk-${i}`,
        complexity: 'high',
      });
      if (!item.ok) continue;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: 780_500_000n,
          spendSource: 'provider',
          currentStageId: terminal!.id,
          updatedAt: new Date(Date.UTC(2026, 3, i + 1)),
        })
        .where(eq(workItems.id, item.value.id));
    }

    const victimCtx = createContext({
      db,
      orgId: victimOrgId,
      actor: { kind: 'human', userId: victim.userId },
    });
    const victimProject = await createProject(victimCtx, {
      key: `VIC${suffix}`,
      name: 'Victim Co',
      template: 'minimal',
    });
    expect(victimProject.ok).toBe(true);
    if (!victimProject.ok) return;

    // Org-filter probe: system actor bypasses can(), so only loadOrgProject
    // (eq projects.orgId, ctx.orgId) stands between foreign orgId and a leak.
    // Cache bypassed — this must not reach the cache-key defence either.
    const foreignSystemCtx = createContext({
      db,
      orgId, // attacker / ambient org — does NOT own victimProject
      actor: { kind: 'system', reason: 'b1-org-filter-probe' },
    });
    const crossEstimate = await estimateForNewItem(foreignSystemCtx, {
      projectId: victimProject.value.id,
      complexity: 'high',
      bypassCache: true,
    });
    expect(crossEstimate.ok).toBe(false);
    if (!crossEstimate.ok) expect(crossEstimate.error.code).toBe('not_found');

    const crossAnalytics = await projectAnalytics(
      foreignSystemCtx,
      victimProject.value.id,
      { from: new Date(Date.now() - 86_400_000), to: new Date() },
    );
    expect(crossAnalytics.ok).toBe(false);
    if (!crossAnalytics.ok) expect(crossAnalytics.error.code).toBe('not_found');

    // Human outsider (membership path) still 404s.
    const crossHuman = await estimateForNewItem(ctx, {
      projectId: victimProject.value.id,
      complexity: 'high',
      bypassCache: true,
    });
    expect(crossHuman.ok).toBe(false);

    const honest = await estimateForNewItem(victimCtx, {
      projectId: victimProject.value.id,
      complexity: 'high',
      bypassCache: true,
    });
    expect(honest.ok).toBe(true);
    if (!honest.ok) return;
    expect(honest.value.kind).toBe('cold_start');
    if (honest.value.kind === 'cold_start') {
      expect(honest.value.n).toBe(0);
      expect(honest.value.basis).not.toMatch(/Attacker/i);
    }

    // Cache-key half of B1: tenant component must differ.
    const victimKey = cacheKey({
      orgId: victimOrgId,
      projectId: victimProject.value.id,
      complexity: 'high',
      labelKeys: [],
    });
    const attackerKey = cacheKey({
      orgId,
      projectId: victimProject.value.id,
      complexity: 'high',
      labelKeys: [],
    });
    expect(victimKey).not.toBe(attackerKey);
    expect(victimKey).toContain(victimOrgId);
  });

  it('denies estimate to non-members with not_found', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const project = await createProject(ctx, {
      key: `Z${suffix}`,
      name: 'Authz Est',
      template: 'minimal',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const stranger = await upsertUserFromPassport(db, {
      externalSub: `p9-stranger-${Date.now()}`,
      email: 'stranger@example.com',
      name: 'Stranger',
    });
    const strangerCtx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: stranger.userId },
    });
    const denied = await estimateForNewItem(strangerCtx, {
      projectId: project.value.id,
      complexity: 'high',
      bypassCache: true,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('not_found');
    }
  });

  it('does not invent estimates across project isolation', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const a = await createProject(ctx, {
      key: `X${suffix}`,
      name: 'Iso A',
      template: 'minimal',
    });
    const b = await createProject(ctx, {
      key: `Y${suffix}`,
      name: 'Iso B',
      template: 'minimal',
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const terminal = await db.query.stages.findFirst({
      where: and(
        eq(stages.projectId, a.value.id),
        eq(stages.isTerminal, true),
        isNull(stages.archivedAt),
      ),
    });

    for (let i = 0; i < 6; i++) {
      const item = await createWorkItem(ctx, {
        projectId: a.value.id,
        title: `iso-${i}`,
        complexity: 'high',
      });
      if (!item.ok) continue;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: 10_000_000n,
          currentStageId: terminal!.id,
          updatedAt: new Date(Date.UTC(2026, 4, i + 1)),
        })
        .where(eq(workItems.id, item.value.id));
    }

    const coldB = await estimateForNewItem(ctx, {
      projectId: b.value.id,
      complexity: 'high',
      bypassCache: true,
    });
    expect(coldB.ok).toBe(true);
    if (!coldB.ok) return;
    // Project B has no history; tier 3 may still find org items with same
    // pipeline fingerprint (minimal). That is intentional widening — but B
    // alone with empty history before org widen would cold-start if fingerprint
    // differed. Minimal shares fingerprint, so tier 3 may return a range.
    // Assert: if range, tier is 3 (org), never silently claiming project history.
    if (coldB.value.kind === 'range') {
      expect(coldB.value.tier).toBe(3);
      expect(coldB.value.basis).toMatch(/organisation|pipeline/i);
    } else {
      expect(coldB.value.kind).toBe('cold_start');
    }
  });

  it('invalidates estimate cache when an item reaches a terminal stage (M24)', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const project = await createProject(ctx, {
      key: `C${suffix}`,
      name: 'Cache Invalidate',
      template: 'empty',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const { addStage } = await import('../projects');
    const start = await addStage(ctx, {
      projectId: project.value.id,
      key: `c_start_${suffix}`,
      name: 'Start',
      position: 0,
      defaultOwnerClass: 'human',
      isInitial: true,
    });
    const end = await addStage(ctx, {
      projectId: project.value.id,
      key: `c_end_${suffix}`,
      name: 'End',
      position: 1,
      defaultOwnerClass: 'human',
      isTerminal: true,
    });
    expect(start.ok && end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const terminal = end.value.find((s) => s.isTerminal);
    expect(terminal).toBeTruthy();
    if (!terminal) return;

    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'to-complete',
      complexity: 'medium',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) return;

    // Populate cache (createWorkItem may already have; force a known key).
    const est = await estimateForNewItem(ctx, {
      projectId: project.value.id,
      complexity: 'medium',
      labelKeys: [],
    });
    expect(est.ok).toBe(true);
    const key = cacheKey({
      orgId: ctx.orgId,
      projectId: project.value.id,
      complexity: 'medium',
      labelKeys: [],
    });
    const cached = await db.query.estimateCache.findFirst({
      where: eq(estimateCache.key, key),
    });
    expect(cached).toBeTruthy();

    const moved = await transitionWorkItem(
      ctx,
      item.value.id,
      { toStageId: terminal.id },
      item.value.version,
    );
    expect(moved.ok).toBe(true);

    const after = await db.query.estimateCache.findFirst({
      where: eq(estimateCache.key, key),
    });
    expect(after).toBeUndefined();
  });
});
