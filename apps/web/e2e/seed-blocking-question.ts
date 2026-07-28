/**
 * Seeds a deterministic blocking question on ALPHA for Playwright inbox journeys.
 * Requires DB_POSTGRES_URL and prior `pnpm db:seed -- --demo`.
 */
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, questions, workItems } from '@nexus/db';
import {
  askQuestion,
  createContext,
  createWorkItem,
  getProjectByKey,
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
  if (!project.ok) {
    throw new Error('ALPHA project missing — run pnpm db:seed -- --demo first');
  }

  const title = 'E2E inbox blocking question';
  const byTitle = await db.query.workItems.findMany({
    where: eq(workItems.projectId, project.value.id),
  });
  let item = byTitle.find((w) => w.title === title) ?? null;
  if (!item) {
    const created = await createWorkItem(ctx, {
      projectId: project.value.id,
      title,
    });
    if (!created.ok) throw new Error(created.error.message);
    item = created.value;
  }

  const openQ = await db.query.questions.findFirst({
    where: and(
      eq(questions.workItemId, item.id),
      eq(questions.status, 'open'),
      eq(questions.blocking, true),
    ),
  });
  if (!openQ) {
    const asked = await askQuestion(ctx, {
      ticketId: item.id,
      text: 'E2E: Which auth provider?',
      blocking: true,
      options: ['Okta', 'Auth0'],
    });
    if (!asked.ok) throw new Error(asked.error.message);
  }

  await reconcileAttention(ctx, [project.value.id]);
  await closeDb();
  console.log(JSON.stringify({ ok: true, workItemKey: item.key }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
