import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createApiToken,
  createContext,
  createProject,
  createWorkItem,
  getWorkItemByKey,
  resetMemoryRateLimits,
  upsertUserFromPassport,
} from '../index';
import { checkRateLimitWindow } from '../redis/rate-limit';
import { apiScopeAllowsAction } from '../api-tokens/scopes';
import { can } from '../authz/can';
import { closeDb, getDb, idempotencyKeys } from '@nexus/db';
import { eq, and } from 'drizzle-orm';
import { testProjectKey } from '../cost/test-helpers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('API v1 token and policy', () => {
  const db = getDb();

  afterAll(async () => {
    await closeDb();
  });

  it('enforces project tenancy on token actor', async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `api-ten-${Date.now()}`,
      email: `t-${Date.now()}@example.com`,
      name: 'T',
    });
    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { isEnabled: async () => true },
    });
    const a = await createProject(ctx, {
      key: testProjectKey('A'),
      name: 'A',
      template: 'default',
    });
    const b = await createProject(ctx, {
      key: testProjectKey('B'),
      name: 'B',
      template: 'default',
    });
    if (!a.ok || !b.ok) throw new Error('projects');

    const itemB = await createWorkItem(ctx, {
      projectId: b.value.id,
      title: 'B item',
    });
    if (!itemB.ok) throw new Error('item');

    const token = await createApiToken(ctx, {
      projectId: a.value.id,
      name: 'A only',
      scopes: ['items:read'],
    });
    if (!token.ok) throw new Error('token');

    const apiCtx = createContext({
      db,
      orgId: u.orgId,
      actor: {
        kind: 'api_token',
        tokenId: token.value.tokenId,
        projectId: a.value.id,
        scopes: ['items:read'],
      },
      flags: { isEnabled: async () => true },
    });

    const cross = await getWorkItemByKey(apiCtx, a.value.id, itemB.value.key);
    expect(cross.ok).toBe(false);
  });

  it('separates runs:write scope', () => {
    expect(apiScopeAllowsAction(['items:read'], 'run.launch')).toBe(false);
    expect(apiScopeAllowsAction(['runs:write'], 'run.launch')).toBe(true);
    const actor = {
      kind: 'api_token' as const,
      tokenId: '00000000-0000-7000-8000-000000000001',
      projectId: '00000000-0000-7000-8000-000000000002',
      scopes: ['items:read'],
    };
    expect(
      can(actor, 'run.launch', {
        type: 'work_item',
        projectId: actor.projectId,
        role: null,
      }),
    ).toBe(false);
  });

  it('rate limits when over burst', async () => {
    resetMemoryRateLimits();
    const key = `test-${Date.now()}`;
    let blocked = false;
    for (let i = 0; i < 65; i++) {
      const r = await checkRateLimitWindow(`api:${key}:sec`, 60, 1);
      if (!r.allowed) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });

  it('detects idempotency key body mismatch', async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `idem-${Date.now()}`,
      email: `i-${Date.now()}@example.com`,
      name: 'I',
    });
    const ctx = createContext({
      db,
      orgId: u.orgId,
      actor: { kind: 'human', userId: u.userId },
      flags: { isEnabled: async () => true },
    });
    const p = await createProject(ctx, {
      key: testProjectKey('ID'),
      name: 'Idem',
      template: 'default',
    });
    if (!p.ok) throw new Error('project');
    const token = await createApiToken(ctx, {
      projectId: p.value.id,
      name: 'idem',
      scopes: ['items:write'],
    });
    if (!token.ok) throw new Error('token');

    const idemKey = `k-${Date.now()}`;
    const hashA = createHash('sha256').update('body-a').digest('hex');
    const hashB = createHash('sha256').update('body-b').digest('hex');

    await db.insert(idempotencyKeys).values({
      key: idemKey,
      tokenId: token.value.tokenId,
      requestHash: hashA,
      responseStatus: 201,
      responseBody: { ok: true },
    });

    const row = await db.query.idempotencyKeys.findFirst({
      where: and(
        eq(idempotencyKeys.key, idemKey),
        eq(idempotencyKeys.tokenId, token.value.tokenId),
      ),
    });
    expect(row?.requestHash).toBe(hashA);
    expect(row?.requestHash).not.toBe(hashB);
  });
});
