import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { jobs, newId, type Db } from '@nexus/db';

export type JobRow = typeof jobs.$inferSelect;

export async function enqueueJob(
  db: Db,
  input: {
    kind: string;
    payload: Record<string, unknown>;
    priority?: number;
    runAfter?: Date;
    dedupeKey?: string;
    maxAttempts?: number;
  },
): Promise<JobRow> {
  const id = newId();
  const [row] = await db
    .insert(jobs)
    .values({
      id,
      kind: input.kind,
      payload: input.payload,
      priority: input.priority ?? 0,
      runAfter: input.runAfter ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 8,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;

  if (input.dedupeKey) {
    const existing = await db.query.jobs.findFirst({
      where: eq(jobs.dedupeKey, input.dedupeKey),
    });
    if (existing) return existing;
  }
  throw new Error('Failed to enqueue job');
}

export async function claimJobs(
  db: Db,
  workerId: string,
  limit = 20,
): Promise<JobRow[]> {
  const result = await db.execute(sql`
    UPDATE jobs SET
      status = 'running',
      locked_by = ${workerId},
      locked_at = now(),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
      ORDER BY priority DESC, run_after ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `);
  return result as unknown as JobRow[];
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'done', updatedAt: new Date(), lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, id));
}

export async function failJob(
  db: Db,
  job: JobRow,
  error: string,
): Promise<void> {
  const dead = job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(
    60 * 60 * 1000,
    1000 * 2 ** Math.min(job.attempts, 10) + Math.floor(Math.random() * 500),
  );
  await db
    .update(jobs)
    .set({
      status: dead ? 'dead' : 'pending',
      lastError: error.slice(0, 4000),
      runAfter: new Date(Date.now() + backoffMs),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
}

export async function queueDepth(db: Db): Promise<{
  pending: number;
  running: number;
  oldestPendingAt: Date | null;
}> {
  const pendingRows = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(run_after)`,
    })
    .from(jobs)
    .where(eq(jobs.status, 'pending'));

  const runningRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.status, 'running'));

  return {
    pending: Number(pendingRows[0]?.count ?? 0),
    running: Number(runningRows[0]?.count ?? 0),
    oldestPendingAt: pendingRows[0]?.oldest ?? null,
  };
}

export async function listPending(
  db: Db,
  limit = 50,
): Promise<JobRow[]> {
  return db.query.jobs.findMany({
    where: and(eq(jobs.status, 'pending'), lte(jobs.runAfter, new Date())),
    orderBy: [desc(jobs.priority), asc(jobs.runAfter)],
    limit,
  });
}
