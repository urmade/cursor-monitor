import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  events,
  getDb,
  mcpTokens,
  newId,
  runs,
  workItems,
} from '@nexus/db';
import {
  closeOutRun,
  createContext,
  createMcpToken,
  createProject,
  createWorkItem,
  upsertUserFromPassport,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('closeOutRun capture fault', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);

  afterAll(async () => {
    delete process.env.NEXUS_TEST_FAULT_CAPTURE;
    await closeDb();
  });

  it('revokes tokens and emits before capture; retries cost on second close-out', async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `close-cap-${Date.now()}`,
      email: 'close-cap@example.com',
      name: 'Close Cap',
    });

    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { async isEnabled() { return true; } },
    });

    const project = await createProject(ctx, {
      key: testProjectKey('CC'),
      name: 'Close capture',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const itemR = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: 'Fault item',
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
      status: 'running',
      nonce: `fault-${runId}`,
      deadlineAt: new Date(Date.now() + 60_000),
      launchedAt: new Date(),
      tokens: { input: 1000, output: 500 },
      model: 'claude-sonnet-4',
    });

    await createMcpToken(db, {
      runId,
      workItemId: itemR.value.id,
      projectId: project.value.id,
    });

    await db
      .update(workItems)
      .set({ currentRunId: runId })
      .where(eq(workItems.id, itemR.value.id));

    process.env.NEXUS_TEST_FAULT_CAPTURE = '1';
    const first = await closeOutRun(ctx, runId);
    expect(first.ok).toBe(true);

    const runAfter = await db.query.runs.findFirst({
      where: eq(runs.id, runId),
    });
    expect(runAfter?.status).toBe('completed_no_report');
    expect(runAfter?.costMicroUsd).toBeNull();

    const itemAfter = await db.query.workItems.findFirst({
      where: eq(workItems.id, itemR.value.id),
    });
    expect(itemAfter?.currentRunId).toBeNull();

    const liveTokens = await db.query.mcpTokens.findMany({
      where: and(eq(mcpTokens.runId, runId), isNull(mcpTokens.revokedAt)),
    });
    expect(liveTokens).toHaveLength(0);

    const ev = await db.query.events.findMany({
      where: and(eq(events.subjectId, runId), eq(events.subjectType, 'run')),
    });
    expect(ev.some((e) => e.type === 'run.completed_without_report')).toBe(true);

    delete process.env.NEXUS_TEST_FAULT_CAPTURE;
    const second = await closeOutRun(ctx, runId);
    expect(second.ok).toBe(true);
    expect(second.ok && second.value.costMicroUsd != null).toBe(true);
  });
});
