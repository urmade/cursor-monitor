/**
 * Seeds a budget-block attention row on ALPHA for Playwright B3 cap raise journey.
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb, workItems } from '@nexus/db';
import {
  createContext,
  createWorkItem,
  getProjectByKey,
  pauseItemForBudget,
  reconcileAttention,
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
  if (!project.ok) throw new Error('ALPHA missing');

  const title = 'E2E budget block raise';
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

  if (item.pausedReason !== 'budget') {
    await pauseItemForBudget(ctx, item.id, 'E2E budget pause');
  }
  await reconcileAttention(ctx, [project.value.id]);
  await closeDb();
  console.log(JSON.stringify({ ok: true, workItemKey: item.key }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
