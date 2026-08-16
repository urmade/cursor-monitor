import { eq } from 'drizzle-orm';
import { appMeta, getDb, newId } from '@nexus/db';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  queueDepth,
} from './queue';
import { getJobHandler } from './registry';
import {
  ensureSweepJob,
  ensureAttentionJobs,
  ensurePendingEvalJobs,
  ensureAutomationUsageSyncJob,
  ensureStopHookCostReconcileJob,
} from './handlers';

export type TickResult = {
  ok: true;
  lastCronTick: string;
  claimed: number;
  completed: number;
  failed: number;
  message: string;
  queue: { pending: number; running: number; oldestPendingAt: string | null };
};

const META_KEY = 'last_cron_tick';

export async function recordLastCronTick(iso: string): Promise<void> {
  const db = getDb();
  await db
    .insert(appMeta)
    .values({
      key: META_KEY,
      value: { iso },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: { iso }, updatedAt: new Date() },
    });
}

export async function readLastCronTick(): Promise<string | null> {
  try {
    const db = getDb();
    const row = await db.query.appMeta.findFirst({
      where: eq(appMeta.key, META_KEY),
    });
    const iso = row?.value?.iso;
    return typeof iso === 'string' ? iso : null;
  } catch {
    return null;
  }
}

/** @deprecated memory helper kept for tests that do not have DB. */
let lastCronTickMemory: string | null = null;

export function getLastCronTickMemory(): string | null {
  return lastCronTickMemory;
}

export async function runCronTick(): Promise<TickResult> {
  const db = getDb();
  const lastCronTick = new Date().toISOString();
  lastCronTickMemory = lastCronTick;
  await recordLastCronTick(lastCronTick);

  await enqueueJob(db, {
    kind: 'noop',
    payload: { source: 'cron_tick', at: lastCronTick },
    dedupeKey: `noop:${lastCronTick.slice(0, 16)}`,
    priority: -10,
  }).catch(() => undefined);

  await ensureSweepJob().catch(() => undefined);
  await ensureAttentionJobs().catch(() => undefined);
  await ensurePendingEvalJobs().catch(() => undefined);
  await ensureAutomationUsageSyncJob().catch(() => undefined);
  await ensureStopHookCostReconcileJob().catch(() => undefined);

  const hour = new Date().getUTCHours();
  if (hour === 3) {
    await enqueueJob(db, {
      kind: 'cursor_live_smoke',
      payload: { at: lastCronTick },
      dedupeKey: `cursor_live_smoke:${lastCronTick.slice(0, 10)}`,
      priority: 0,
    }).catch(() => undefined);
  }

  const workerId = `cron-${newId().slice(0, 8)}`;
  const claimed = await claimJobs(db, workerId, 20);
  let completed = 0;
  let failed = 0;

  for (const job of claimed) {
    const handler = getJobHandler(job.kind);
    if (!handler) {
      await failJob(db, job, `No handler registered for kind=${job.kind}`);
      failed += 1;
      continue;
    }
    try {
      await handler(db, job);
      await completeJob(db, job.id);
      completed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(db, job, message);
      failed += 1;
    }
  }

  const depth = await queueDepth(db);

  return {
    ok: true,
    lastCronTick,
    claimed: claimed.length,
    completed,
    failed,
    message:
      claimed.length === 0
        ? 'idle'
        : `processed ${completed}/${claimed.length}`,
    queue: {
      pending: depth.pending,
      running: depth.running,
      oldestPendingAt: depth.oldestPendingAt
        ? new Date(depth.oldestPendingAt).toISOString()
        : null,
    },
  };
}
