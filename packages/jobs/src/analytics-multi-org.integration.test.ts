/**
 * M23: nightly analytics must process every org, not stop after the first.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  analyticsDaily,
  closeDb,
  getDb,
  newId,
  orgs,
  users,
} from '@nexus/db';
import {
  createContext,
  createFlagReader,
  createProject,
  silentLogger,
  upsertUserFromPassport,
  yesterdayUtc,
} from '@nexus/core';
import { getJobHandler } from './registry';
import type { JobRow } from './queue';
import './handlers';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('compute_analytics_daily multi-org (M23)', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);

  afterAll(async () => {
    await closeDb();
  });

  it('writes analytics_daily for every organisation', async () => {
    const suffix = Date.now().toString(36).toLowerCase();
    const seeded: Array<{ orgId: string; projectId: string }> = [];

    for (let i = 0; i < 2; i++) {
      const u = await upsertUserFromPassport(db, {
        externalSub: `m23-user-${suffix}-${i}`,
        email: `m23-${suffix}-${i}@example.com`,
        name: `M23 ${i}`,
      });
      const orgId = newId();
      await db.insert(orgs).values({
        id: orgId,
        name: `M23 Org ${i}`,
        slug: `m23-${suffix}-${i}`,
      });
      await db.update(users).set({ orgId }).where(eq(users.id, u.userId));

      const ctx = createContext({
        db,
        orgId,
        actor: { kind: 'human', userId: u.userId },
        flags: createFlagReader(db),
        logger: silentLogger,
      });
      const project = await createProject(ctx, {
        key: `M${i}${suffix.slice(-4)}`.toUpperCase(),
        name: `M23 Project ${i}`,
        template: 'minimal',
      });
      expect(project.ok).toBe(true);
      if (!project.ok) return;
      seeded.push({ orgId, projectId: project.value.id });
    }

    const handler = getJobHandler('compute_analytics_daily');
    expect(handler).toBeTruthy();
    const day = yesterdayUtc();
    const dayKey = day.toISOString().slice(0, 10);
    const job = {
      id: newId(),
      kind: 'compute_analytics_daily',
      payload: { day: dayKey },
      status: 'running',
      attempts: 1,
      maxAttempts: 3,
      priority: 2,
      runAfter: new Date(),
      lockedAt: new Date(),
      lockedBy: 'test',
      lastError: null,
      dedupeKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as JobRow;
    await handler!(db, job);

    for (const s of seeded) {
      const row = await db.query.analyticsDaily.findFirst({
        where: and(
          eq(analyticsDaily.projectId, s.projectId),
          eq(analyticsDaily.day, dayKey),
        ),
      });
      expect(row, `missing analytics_daily for org ${s.orgId}`).toBeTruthy();
    }
  });
});
