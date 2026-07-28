/**
 * Seeds a failed-run attention row on ALPHA for Playwright B2 retry journey.
 * Requires DB_POSTGRES_URL and `pnpm db:seed -- --demo`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { attentionItems, automationBindings, closeDb, getDb, newId, runs, workItems } from '@nexus/db';
import {
  createContext,
  createWorkItem,
  getProjectByKey,
  handleAttentionEvent,
  reconcileAttention,
  upsertBinding,
  upsertUserFromPassport,
} from '@nexus/core';

async function main(): Promise<void> {
  const db = getDb();
  const { userId, orgId } = await upsertUserFromPassport(db, {
    externalSub: 'local-dev-user',
    email: 'local@example.com',
    name: 'Local Dev',
  });
  const ctx = createContext({
    db,
    orgId,
    actor: { kind: 'human', userId },
    flags: { isEnabled: async () => true },
  });

  const project = await getProjectByKey(ctx, 'ALPHA');
  if (!project.ok) throw new Error('ALPHA missing — run pnpm db:seed -- --demo');

  const title = 'E2E failed run retry';
  const items = await db.query.workItems.findMany({
    where: eq(workItems.projectId, project.value.id),
  });
  let item = items.find((w) => w.title === title) ?? null;
  if (!item) {
    const created = await createWorkItem(ctx, {
      projectId: project.value.id,
      title,
    });
    if (!created.ok) throw new Error(created.error.message);
    item = created.value;
  }

  if (!item.currentStageInstanceId) throw new Error('no stage instance');

  const binding = await db.query.automationBindings.findFirst({
    where: and(
      eq(automationBindings.projectId, project.value.id),
      eq(automationBindings.stageId, item.currentStageId),
    ),
  });
  if (!binding) {
    const createdBinding = await upsertBinding(ctx, {
      projectId: project.value.id,
      stageId: item.currentStageId,
      name: 'E2E inbox retry',
      adapter: 'automation_webhook',
      config: { webhookUrlSecretKey: 'E2E_WEBHOOK_URL' },
      enabled: true,
    });
    if (!createdBinding.ok) throw new Error(createdBinding.error.message);
  }

  await db
    .update(runs)
    .set({ status: 'abandoned', terminalAt: new Date() })
    .where(
      and(
        eq(runs.workItemId, item.id),
        inArray(runs.status, ['pending', 'launched', 'running', 'launch_failed']),
      ),
    );

  const existing = await db.query.runs.findFirst({
    where: and(eq(runs.workItemId, item.id), eq(runs.status, 'failed')),
  });
  const runId = existing?.id ?? newId();
  if (!existing) {
    await db.insert(runs).values({
      id: runId,
      workItemId: item.id,
      stageInstanceId: item.currentStageInstanceId,
      adapter: 'cloud_agent',
      trigger: { kind: 'e2e' },
      status: 'failed',
      nonce: `e2e-fail-${runId}`,
      deadlineAt: new Date(Date.now() + 3_600_000),
      errorCode: 'e2e_fail',
      terminalAt: new Date(),
    });
    await db.update(workItems).set({ currentRunId: runId }).where(eq(workItems.id, item.id));
  } else {
    await db.update(workItems).set({ currentRunId: runId }).where(eq(workItems.id, item.id));
  }

  await db
    .update(attentionItems)
    .set({ status: 'resolved', resolvedAt: new Date(), resolution: 'e2e_reset' })
    .where(
      and(eq(attentionItems.workItemId, item.id), eq(attentionItems.status, 'open')),
    );

  await handleAttentionEvent(ctx, {
    type: 'run.failed',
    projectId: project.value.id,
    subjectType: 'run',
    subjectId: runId,
    payload: { workItemId: item.id, errorCode: 'e2e_fail' },
  });
  await reconcileAttention(ctx, [project.value.id]);
  await closeDb();
  console.log(JSON.stringify({ ok: true, workItemKey: item.key, runId }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
