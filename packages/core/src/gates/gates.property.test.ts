import { describe, expect, it } from 'vitest';
import type { GateOutcome } from '@nexus/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDb, getDb, gateEvaluations, stages } from '@nexus/db';
import { worstOutcome } from './evaluate';
import { emptyGateContext, evaluateCondition } from '../conditions';
import {
  createContext,
  createGate,
  createProject,
  createWorkItem,
  evaluateGates,
  ensureDefaultEvaluatorsRegistered,
  getEvaluator,
  upsertUserFromPassport,
} from '../index';

ensureDefaultEvaluatorsRegistered();

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe('property: batch outcome equals worst individual', () => {
  it('worstOutcome matches manual ranking on random sets', () => {
    const rank = (o: GateOutcome): number => {
      if (o === 'block' || o === 'error') return 3;
      if (o === 'warn') return 2;
      return 1;
    };
    const pool: GateOutcome[] = ['pass', 'warn', 'block', 'skipped', 'error'];
    for (let i = 0; i < 100; i++) {
      const n = 1 + Math.floor(Math.random() * 10);
      const outcomes: GateOutcome[] = [];
      for (let j = 0; j < n; j++) {
        outcomes.push(pool[Math.floor(Math.random() * pool.length)]!);
      }
      const expected =
        Math.max(...outcomes.map(rank)) === 3
          ? 'block'
          : Math.max(...outcomes.map(rank)) === 2
            ? 'warn'
            : 'pass';
      expect(worstOutcome(outcomes)).toBe(expected);
    }
  });
});

describe.runIf(hasDb)('property: evaluateGates batch path', () => {
  const db = getDb();

  it('N blocking gates → N results, N rows, one context snapshot, no stage mutation', async () => {
    const owner = await upsertUserFromPassport(db, {
      externalSub: `prop-gates-${Date.now()}`,
      email: 'prop@example.com',
      name: 'Prop',
    });
    const ctx = createContext({
      db,
      orgId: owner.orgId,
      actor: { kind: 'human', userId: owner.userId },
      flags: { async isEnabled() { return true; } },
    });
    const project = await createProject(ctx, {
      key: `PG${Date.now().toString(36).toUpperCase().slice(-4)}`,
      name: 'Prop Gates',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const { updateProject } = await import('../projects');
    await updateProject(ctx, project.value.id, {
      settings: { enforcement_mode: 'enforce' },
    });

    const stageRows = await db.query.stages.findMany({
      where: and(
        eq(stages.projectId, project.value.id),
        isNull(stages.archivedAt),
      ),
    });
    const plan = stageRows.find((s) => s.key === 'plan')!;
    const scoping = stageRows.find((s) => s.key === 'scoping')!;

    for (let i = 0; i < 4; i++) {
      await createGate(ctx, {
        projectId: project.value.id,
        name: `Block ${i}`,
        evaluator: 'field_rule',
        trigger: { kind: 'on_transition', toStageId: plan.id },
        config: {
          require: { op: 'eq', field: 'ticket.complexity', value: 'impossible' },
          message: `block-${i}`,
          code: `block.${i}`,
        },
        onFailure: 'block',
        enabled: true,
      });
    }

    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Prop item',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) return;

    let current = item.value;
    if (current.currentStageId !== scoping.id) {
      const { transitionWorkItem } = await import('../workitems');
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    const beforeStage = current.currentStageId;
    const beforeVersion = current.version;

    const batch = await evaluateGates(ctx, {
      workItemId: current.id,
      trigger: { kind: 'on_transition', toStageId: plan.id },
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    expect(batch.value.results).toHaveLength(4);
    expect(batch.value.outcome).toBe('block');
    expect(batch.value.blockedBy).toHaveLength(4);
    expect(worstOutcome(batch.value.results.map((r) => r.outcome))).toBe(
      batch.value.outcome,
    );

    const rows = await db.query.gateEvaluations.findMany({
      where: eq(gateEvaluations.batchId, batch.value.batchId),
    });
    expect(rows).toHaveLength(4);
    const snapshots = new Set(rows.map((r) => JSON.stringify(r.contextSnapshot)));
    expect(snapshots.size).toBe(1);

    const { workItems } = await import('@nexus/db');
    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    expect(refreshed?.currentStageId).toBe(beforeStage);
    expect(refreshed?.version).toBe(beforeVersion);
  });
});

describe('performance: 20 gates × context is cheap', () => {
  it('evaluates 20 field_rule gates under 150ms in-process', async () => {
    const ctx = emptyGateContext({
      ticket: {
        id: '00000000-0000-7000-8000-000000000001',
        projectId: '00000000-0000-7000-8000-000000000002',
        title: 'Perf',
        complexity: 'medium',
        ownerClass: 'human',
        stageKey: 'plan',
        stageId: '00000000-0000-7000-8000-000000000003',
        currentStageInstanceId: null,
      },
      labels: ['risk:low'],
      spec: { exists: true, acceptanceCriteriaCount: 3 },
    });
    const ev = getEvaluator('field_rule')!;
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      await ev({
        gate: {
          id: `g${i}`,
          projectId: ctx.project.id,
          name: `Gate ${i}`,
          description: '',
          evaluator: 'field_rule',
          trigger: {
            kind: 'on_transition',
            toStageId: '00000000-0000-7000-8000-000000000010',
          },
          appliesWhen: null,
          config: {
            require: { op: 'exists', field: 'ticket.complexity' },
            message: 'ok',
          },
          onFailure: 'block',
          enabled: true,
          version: 1,
        },
        ctx,
        trigger: {
          kind: 'on_transition',
          toStageId: '00000000-0000-7000-8000-000000000010',
        },
      });
    }
    expect(performance.now() - start).toBeLessThan(150);
  });

  it('200 dry-run field evaluations stay interactive', () => {
    const ctx = emptyGateContext({
      labels: ['a', 'b'],
      warnings: { openCount: 2, openInCurrentStageCount: 1, openCodes: ['x'] },
    });
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      evaluateCondition(
        {
          op: 'and',
          of: [
            { op: 'exists', field: 'ticket.title' },
            { op: 'count_gte', field: 'warnings.open.count', value: 1 },
          ],
        },
        ctx,
      );
    }
    expect(performance.now() - start).toBeLessThan(100);
  });
});

if (!hasDb) {
  // keep closeDb unused path quiet when skipping
  void closeDb;
}
