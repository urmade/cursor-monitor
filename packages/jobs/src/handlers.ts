import {
  createContext,
  createFlagReader,
  pollRun,
  silentLogger,
  sweepStuckRuns,
} from '@nexus/core';
import { CursorClient } from '@nexus/cursor-client';
import { getDb } from '@nexus/db';
import { registerJobHandler } from './registry';
import { enqueueJob } from './queue';

registerJobHandler('poll_run', async (db, job) => {
  const runId = String((job.payload as { runId?: string }).runId ?? '');
  if (!runId) throw new Error('poll_run missing runId');

  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'poll_run' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });

  const result = await pollRun(ctx, runId);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
});

registerJobHandler('sweep_stuck_runs', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'sweep_stuck_runs' },
    flags: createFlagReader(db),
  });
  await sweepStuckRuns(ctx);
});

registerJobHandler('cursor_live_smoke', async () => {
  const apiKey =
    process.env.CURSOR_API_KEY ?? process.env.CURSOR_SERVICE_ACCOUNT_KEY;
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY not set; skip live smoke');
  }
  const client = new CursorClient({ apiKey });
  const models = await client.listModels();
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('listModels returned empty — possible API drift');
  }
  // Fixture sanity: model must be object form on create — covered by unit tests;
  // here we only assert the live endpoint still responds.
});

/**
 * Gate evaluation for on_run_finished / on_label_added runs inline from
 * closeOutRun / setLabels (core cannot depend on @nexus/jobs without a cycle).
 * Dead `gate_on_*` handlers were removed rather than left registered-but-unenqueued.
 */

/** Enqueue the hourly stuck sweep if not already pending. */
export async function ensureSweepJob(): Promise<void> {
  const db = getDb();
  await enqueueJob(db, {
    kind: 'sweep_stuck_runs',
    payload: {},
    dedupeKey: `sweep_stuck_runs:${new Date().toISOString().slice(0, 13)}`,
    priority: 5,
  });
}
