import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, newId, runs, stageInstances, workItems } from '@nexus/db';
import {
  captureRunCostAtCloseOut,
  createContext,
  createProject,
  createWorkItem,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from './test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('captureRunCostAtCloseOut concurrency', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  afterAll(async () => {
    await closeDb();
  });

  it('applies rollup once when two close-outs race', async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `cap-race-${Date.now()}`,
      email: 'cap-race@example.com',
      name: 'Cap Race',
    });
    orgId = u.orgId;
    userId = u.userId;

    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { async isEnabled() { return true; } },
    });

    const project = await createProject(ctx, {
      key: testProjectKey('CR'),
      name: 'Cap race',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const itemR = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Race item',
    });
    expect(itemR.ok).toBe(true);
    if (!itemR.ok) return;

    const wi = await db.query.workItems.findFirst({
      where: eq(workItems.id, itemR.value.id),
    });
    const stageInstanceId = wi!.currentStageInstanceId!;

    const runId = newId();
    await db.insert(runs).values({
      id: runId,
      workItemId: itemR.value.id,
      stageInstanceId,
      adapter: 'cloud_agent',
      trigger: { kind: 'test' },
      status: 'completed',
      nonce: `race-${runId}`,
      deadlineAt: new Date(Date.now() + 60_000),
      terminalAt: new Date(),
      tokens: { input: 1000, output: 500, chargedCents: 213 },
      model: 'claude-sonnet-4',
      costMicroUsd: null,
    });

    const [a, b] = await Promise.all([
      captureRunCostAtCloseOut(ctx, runId),
      captureRunCostAtCloseOut(ctx, runId),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const itemAfter = await db.query.workItems.findFirst({
      where: eq(workItems.id, itemR.value.id),
    });
    expect(itemAfter?.spendMicroUsd).toBe(a.value.costMicro);
    expect(itemAfter?.spendMicroUsd).not.toBe(a.value.costMicro * BigInt(2));

    const stage = await db.query.stageInstances.findFirst({
      where: eq(stageInstances.id, stageInstanceId),
    });
    expect(stage?.costMicroUsd).toBe(a.value.costMicro);
  });
});
