import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb, events, featureFlags, getDb, newId, orgs, users } from '@nexus/db';
import {
  createApiToken,
  createContext,
  createProject,
  createWorkItem,
} from '@nexus/core';
import { PATCH } from '../../app/api/v1/[[...path]]/route';

function testProjectKey(prefix = 'RB'): string {
  const suffix = Date.now().toString(36).toUpperCase().slice(-6);
  return `${prefix}${suffix}`.replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
}

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('API v1 route org tenancy (adapter)', () => {
  const db = getDb();

  beforeAll(async () => {
    process.env.FLAG_P8_API = 'true';
    await db
      .insert(featureFlags)
      .values({
        key: 'p8.api',
        enabled: true,
        enabledForProjectIds: [],
      })
      .onConflictDoNothing();
  });

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
      externalSub: `route-org-${slug}-${Date.now()}`,
      email: `${slug}-${Date.now()}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return { orgId, userId };
  }

  it('PATCH work-items uses token project org on emitted events (not first org)', async () => {
    const orgA = await createIsolatedOrg(`route-a-${Date.now().toString(36)}`);
    const orgB = await createIsolatedOrg(`route-b-${Date.now().toString(36)}`);

    await createIsolatedOrg(`filler-${Date.now()}`);

    const humanB = createContext({
      db,
      orgId: orgB.orgId,
      actor: { kind: 'human', userId: orgB.userId },
      flags: { isEnabled: async () => true },
    });

    const projectB = await createProject(humanB, {
      key: testProjectKey('RB'),
      name: 'RouteSecondCo',
      template: 'default',
    });
    expect(projectB.ok).toBe(true);
    if (!projectB.ok) throw new Error('project');

    const item = await createWorkItem(humanB, {
      projectId: projectB.value.id,
      title: 'Before',
      complexity: 'low',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error('item');

    const token = await createApiToken(humanB, {
      projectId: projectB.value.id,
      name: 'route',
      scopes: ['items:read', 'items:write'],
    });
    expect(token.ok).toBe(true);
    if (!token.ok) throw new Error('token');

    const req = new Request(`http://localhost/api/v1/work-items/${item.value.key}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token.value.plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'After HTTP' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ path: ['work-items', item.value.key] }) });
    expect(res.status).toBe(200);

    const evt = await db.query.events.findFirst({
      where: eq(events.subjectId, item.value.id),
      orderBy: [desc(events.occurredAt)],
    });
    expect(evt?.type).toBe('work_item.updated');
    expect(evt?.orgId).toBe(orgB.orgId);
    expect(evt?.orgId).not.toBe(orgA.orgId);
  });
});
