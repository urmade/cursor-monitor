#!/usr/bin/env npx tsx
/**
 * Mint a demo API token for ALPHA (local dev / §9 script). Requires DB_POSTGRES_URL.
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb, projects } from '@nexus/db';
import { createApiToken, createContext, upsertUserFromPassport } from '@nexus/core';

async function main() {
  const db = getDb();
  const u = await upsertUserFromPassport(db, {
    externalSub: 'local-dev-user',
    email: 'local@example.com',
    name: 'Local Dev',
  });
  const ctx = createContext({
    db,
    orgId: u.orgId,
    actor: { kind: 'human', userId: u.userId },
    flags: { isEnabled: async () => true },
  });
  const alpha = await db.query.projects.findFirst({
    where: eq(projects.key, 'ALPHA'),
  });
  if (!alpha) {
    console.error('Run pnpm db:seed -- --demo first (ALPHA project missing).');
    process.exit(1);
  }
  const token = await createApiToken(ctx, {
    projectId: alpha.id,
    name: 'examples-api-drive',
    scopes: [
      'projects:read',
      'items:read',
      'items:write',
      'items:transition',
    ],
  });
  if (!token.ok) {
    console.error(token.error.message);
    process.exit(1);
  }
  console.log(token.value.plaintext);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
