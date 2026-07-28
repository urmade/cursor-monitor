/**
 * End-to-end B1 probe through the HTTP v1 route.
 *
 * Phase 8 derives ctx.orgId from the token's project (not orgs.findFirst).
 * Phase 9 filters estimates by that orgId. Together for the first time here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  featureFlags,
  getDb,
  newId,
  orgs,
  stages,
  users,
  workItems,
} from '@nexus/db';
import {
  createApiToken,
  createContext,
  createProject,
  createWorkItem,
} from '@nexus/core';
import { GET } from '../../app/api/v1/[[...path]]/route';

function testProjectKey(prefix = 'EO'): string {
  const suffix = Date.now().toString(36).toUpperCase().slice(-6);
  return `${prefix}${suffix}`.replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
}

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('API v1 estimate org tenancy (Phase 8+9)', () => {
  const db = getDb();

  beforeAll(async () => {
    process.env.FLAG_P8_API = 'true';
    process.env.FLAG_P9_ESTIMATES = 'true';
    await db
      .insert(featureFlags)
      .values([
        { key: 'p8.api', enabled: true, enabledForProjectIds: [] },
        { key: 'p9.estimates', enabled: true, enabledForProjectIds: [] },
      ])
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
      externalSub: `est-org-${slug}-${Date.now()}`,
      email: `${slug}-${Date.now()}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return { orgId, userId };
  }

  it('estimate uses token project orgId — not first org — and denies cross-org keys', async () => {
    // First org in the table: the old findFirst() trap.
    const orgA = await createIsolatedOrg(`est-first-${Date.now().toString(36)}`);
    const humanA = createContext({
      db,
      orgId: orgA.orgId,
      actor: { kind: 'human', userId: orgA.userId },
      flags: { isEnabled: async () => true },
    });
    const projectA = await createProject(humanA, {
      key: testProjectKey('EA'),
      name: 'FirstOrgRichPool',
      template: 'minimal',
    });
    expect(projectA.ok).toBe(true);
    if (!projectA.ok) throw new Error('projectA');

    const terminalA = await db.query.stages.findFirst({
      where: and(
        eq(stages.projectId, projectA.value.id),
        eq(stages.isTerminal, true),
        isNull(stages.archivedAt),
      ),
    });
    for (let i = 0; i < 8; i++) {
      const item = await createWorkItem(humanA, {
        projectId: projectA.value.id,
        title: `rich-a-${i}`,
        complexity: 'high',
      });
      if (!item.ok) continue;
      await db
        .update(workItems)
        .set({
          spendMicroUsd: 990_000_000n,
          spendSource: 'provider',
          currentStageId: terminalA!.id,
          updatedAt: new Date(Date.UTC(2026, 2, i + 1)),
        })
        .where(eq(workItems.id, item.value.id));
    }

    // Second org: the token subject. If orgId were findFirst(), estimates would
    // pull FirstOrgRichPool into the comparable set / cache key.
    const orgB = await createIsolatedOrg(`est-token-${Date.now().toString(36)}`);
    const humanB = createContext({
      db,
      orgId: orgB.orgId,
      actor: { kind: 'human', userId: orgB.userId },
      flags: { isEnabled: async () => true },
    });
    const projectB = await createProject(humanB, {
      key: testProjectKey('EB'),
      name: 'TokenOrgCold',
      template: 'minimal',
    });
    expect(projectB.ok).toBe(true);
    if (!projectB.ok) throw new Error('projectB');

    const token = await createApiToken(humanB, {
      projectId: projectB.value.id,
      name: 'estimate-org',
      scopes: ['projects:read', 'items:read'],
    });
    expect(token.ok).toBe(true);
    if (!token.ok) throw new Error('token');

    const okReq = new Request(
      `http://localhost/api/v1/projects/${projectB.value.key}/estimate?complexity=high`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token.value.plaintext}` },
      },
    );
    const okRes = await GET(okReq, {
      params: Promise.resolve({
        path: ['projects', projectB.value.key, 'estimate'],
      }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      estimate: { kind: string; n: number; basis?: string };
    };
    expect(okBody.estimate.kind).toBe('cold_start');
    expect(okBody.estimate.n).toBe(0);
    expect(okBody.estimate.basis ?? '').not.toMatch(/FirstOrgRichPool/i);

    // Cross-org project key with B's token must 404 (token project binding).
    const crossReq = new Request(
      `http://localhost/api/v1/projects/${projectA.value.key}/estimate?complexity=high`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token.value.plaintext}` },
      },
    );
    const crossRes = await GET(crossReq, {
      params: Promise.resolve({
        path: ['projects', projectA.value.key, 'estimate'],
      }),
    });
    expect(crossRes.status).toBe(404);
  });
});
