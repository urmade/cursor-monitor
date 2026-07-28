import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, newId, pendingEvaluations } from '@nexus/db';
import {
  createContext,
  createProject,
  createWorkItem,
  createGate,
  upsertUserFromPassport,
  updateProject,
  createRubric,
  processPendingEvaluations,
  reclaimStaleRunningEvaluations,
  scrubOldRawResponses,
} from '../index';
import { stages } from '@nexus/db';

process.env.FLAG_P3_GATES = '1';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('rubric job handlers', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let ownerId = '';

  beforeAll(async () => {
    const owner = await upsertUserFromPassport(db, {
      externalSub: `p7-jobs-${Date.now()}`,
      email: 'p7-jobs@example.com',
      name: 'P7 Jobs',
    });
    orgId = owner.orgId;
    ownerId = owner.userId;
  });

  afterAll(async () => {
    await closeDb();
  });

  function ctx() {
    return createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: ownerId },
      flags: {
        async isEnabled(key: string) {
          return (
            key === 'p3.gates' ||
            key === 'p2.runs' ||
            key === 'orchestration.enabled'
          );
        },
      },
    });
  }

  it('scrubOldRawResponses is safe with empty set (no throw)', async () => {
    const c = ctx();
    const n = await scrubOldRawResponses(c, 30);
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('reclaimStaleRunningEvaluations returns stuck running rows to pending', async () => {
    const c = ctx();
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const project = await createProject(c, {
      key: `J${suffix}`,
      name: 'Jobs',
      template: 'minimal',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('p');
    await updateProject(c, project.value.id, {
      settings: { enforcement_mode: 'enforce' },
    });
    const item = await createWorkItem(c, {
      projectId: project.value.id,
      title: 'pending eval',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error('i');

    const rubric = await createRubric(c, {
      projectId: project.value.id,
      name: 'J',
      target: 'spec',
      question: 'q',
      criteria: [{ key: 'ok', statement: 'ok', weight: 'must' }],
      passWhen: 'p',
      blockWhen: 'b',
      guidance: '',
      model: 'fixture',
      maxOutputTokens: 400,
      uncertaintyPolicy: 'warn',
    });
    expect(rubric.ok).toBe(true);
    if (!rubric.ok) throw new Error('r');

    const stageRows = await db.query.stages.findMany({
      where: eq(stages.projectId, project.value.id),
    });
    const toStage = [...stageRows].sort((a, b) => a.position - b.position)[1]!;
    const gate = await createGate(c, {
      projectId: project.value.id,
      name: 'async',
      evaluator: 'agentic',
      trigger: { kind: 'on_transition', toStageId: toStage.id },
      config: { rubricId: rubric.value.id, async: true },
      onFailure: 'block',
      enabled: true,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error('g');

    const pendingId = newId();
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await db.insert(pendingEvaluations).values({
      id: pendingId,
      workItemId: item.value.id,
      gateId: gate.value.id,
      projectId: project.value.id,
      trigger: { kind: 'on_demand' },
      status: 'running',
      createdAt: old,
    });

    const reclaimed = await reclaimStaleRunningEvaluations(c, 5 * 60 * 1000);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const row = await db.query.pendingEvaluations.findFirst({
      where: eq(pendingEvaluations.id, pendingId),
    });
    expect(row?.status).toBe('pending');

    // processPendingEvaluations should claim without unique-index wedge
    const processed = await processPendingEvaluations(c, 5);
    expect(processed.reclaimed).toBeGreaterThanOrEqual(0);
  });
});
