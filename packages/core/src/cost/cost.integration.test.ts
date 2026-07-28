import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, newId, runs, workItems } from '@nexus/db';
import {
  applyCostRollups,
  captureRunCostAtCloseOut,
  createContext,
  createProject,
  createWorkItem,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from './test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('phase 4 cost rollups', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `p4-${Date.now()}`,
      email: 'p4@example.com',
      name: 'P4',
    });
    orgId = u.orgId;
    userId = u.userId;
  });

  it('rollup equals sum of runs', async () => {
    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { async isEnabled() { return true; } },
    });
    const project = await createProject(ctx, {
      key: testProjectKey('P4'),
      name: 'P4 Cost',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Cost test',
      complexity: 'high',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);

    const wi = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(wi?.currentStageInstanceId).toBeTruthy();
    const stageInstanceId = wi!.currentStageInstanceId!;

    const runId = newId();
    await db.insert(runs).values({
      id: runId,
      workItemId: item.value.id,
      stageInstanceId,
      adapter: 'cloud_agent',
      trigger: { kind: 'test' },
      status: 'completed',
      nonce: `n-${runId}`,
      deadlineAt: new Date(Date.now() + 60_000),
      terminalAt: new Date(),
      tokens: { input: 1000, output: 500, total: 1500, chargedCents: 12 },
      model: 'claude-sonnet-4',
    });

    const captured = await captureRunCostAtCloseOut(ctx, runId);
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error(captured.error.message);

    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    expect(run?.costMicroUsd).not.toBeNull();
    expect(run?.costSource).toBe('provider');

    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(refreshed?.spendMicroUsd).toBe(run?.costMicroUsd);
  });

  it('concurrent rollup increments are atomic', async () => {
    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { async isEnabled() { return true; } },
    });
    const project = await createProject(ctx, {
      key: testProjectKey('P4C'),
      name: 'Concurrent',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error(project.error.message);

    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Concurrent',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error(item.error.message);

    const wi = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(wi?.currentStageInstanceId).toBeTruthy();
    const stageInstanceId = wi!.currentStageInstanceId!;

    const delta = BigInt(1000);
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const runId = newId();
        await db.insert(runs).values({
          id: runId,
          workItemId: item.value.id,
          stageInstanceId,
          adapter: 'cloud_agent',
          trigger: {},
          status: 'completed',
          nonce: `nc-${runId}`,
          deadlineAt: new Date(Date.now() + 60_000),
          costMicroUsd: delta,
          costSource: 'estimated',
        });
        await applyCostRollups(db, {
          runId,
          workItemId: item.value.id,
          stageInstanceId,
          projectId: project.value.id,
          deltaMicro: delta,
          costSource: 'estimated',
        });
      }),
    );

    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(refreshed?.spendMicroUsd).toBe(BigInt(50) * delta);
  });
});
