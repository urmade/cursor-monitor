import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeDb,
  events,
  getDb,
  newId,
  orgs,
  users,
  workItems,
} from '@nexus/db';
import {
  createApiToken,
  createContext,
  createProject,
  createWorkItem,
  updateWorkItem,
} from '../index';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('API token org_id on writes', () => {
  const db = getDb();

  afterAll(async () => {
    await closeDb();
  });

  async function createIsolatedOrg(slug: string) {
    const orgId = newId();
    await db.insert(orgs).values({ id: orgId, name: slug, slug });
    const userId = newId();
    await db.insert(users).values({
      id: userId,
      orgId,
      externalSub: `api-org-${slug}-${Date.now()}`,
      email: `${slug}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return { orgId, userId };
  }

  it('emits events with org_id matching the token project org', async () => {
    const orgA = await createIsolatedOrg(`co-a-${Date.now().toString(36)}`);
    const orgB = await createIsolatedOrg(`co-b-${Date.now().toString(36)}`);

    const _humanA = createContext({
      db,
      orgId: orgA.orgId,
      actor: { kind: 'human', userId: orgA.userId },
      flags: { isEnabled: async () => true },
    });
    const humanB = createContext({
      db,
      orgId: orgB.orgId,
      actor: { kind: 'human', userId: orgB.userId },
      flags: { isEnabled: async () => true },
    });

    const projectB = await createProject(humanB, {
      key: testProjectKey('SC'),
      name: 'SecondCo',
      template: 'default',
    });
    expect(projectB.ok).toBe(true);
    if (!projectB.ok) throw new Error('project');

    const item = await createWorkItem(humanB, {
      projectId: projectB.value.id,
      title: 'Second item',
      complexity: 'low',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error('item');

    const token = await createApiToken(humanB, {
      projectId: projectB.value.id,
      name: 'second',
      scopes: ['items:read', 'items:write'],
    });
    if (!token.ok) throw new Error('token');

    const apiCtx = createContext({
      db,
      orgId: orgB.orgId,
      actor: {
        kind: 'api_token',
        tokenId: token.value.tokenId,
        projectId: projectB.value.id,
        scopes: ['items:read', 'items:write'],
      },
      flags: { isEnabled: async () => true },
    });

    const updated = await updateWorkItem(
      apiCtx,
      item.value.id,
      { title: 'Updated via API token' },
      item.value.version,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error('update');

    const evt = await db.query.events.findFirst({
      where: eq(events.subjectId, item.value.id),
      orderBy: (e, { desc }) => [desc(e.occurredAt)],
    });
    expect(evt?.orgId).toBe(orgB.orgId);
    expect(evt?.orgId).not.toBe(orgA.orgId);

    const row = await db.query.workItems.findFirst({
      where: eq(workItems.id, item.value.id),
    });
    expect(row?.title).toBe('Updated via API token');
  });
});
