import {
  createContext,
  createFlagReader,
  pollRun,
  recomputeCostRollupsJob,
  reconcileWindow,
  silentLogger,
  sweepStuckRuns,
  dispatchAttentionEvents,
  reconcileAttention,
  rescoreOpenItems,
  evaluateRubric,
  evaluateGates,
  processPendingEvaluations,
  scrubOldRawResponses,
  dispatchWebhookEventsDrain,
  deliverPendingWebhooks,
  migrateLegacyWebhookDispatcherCursor,
  computeDaily,
  runBacktest,
  yesterdayUtc,
  resumeAfterQuestion,
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

registerJobHandler('recompute_cost_rollups', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'recompute_cost_rollups' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await recomputeCostRollupsJob(ctx);
});

registerJobHandler('reconcile_costs_admin', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'reconcile_costs_admin' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  const to = new Date();
  const from = new Date(to.getTime() - 72 * 60 * 60 * 1000);
  await reconcileWindow(ctx, { from, to });
});

registerJobHandler('dispatch_attention_events', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'dispatch_attention_events' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await dispatchAttentionEvents(ctx, 200);
});

registerJobHandler('reconcile_attention', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'reconcile_attention' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await reconcileAttention(ctx);
});

registerJobHandler('resume_after_question', async (db, job) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'resume_after_question' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  const p = job.payload as {
    questionId?: string;
    answer?: string;
    workItemId?: string;
    attempt?: number;
    forceFreshAgent?: boolean;
  };
  if (!p.questionId || !p.workItemId || !p.answer) {
    throw new Error('resume_after_question missing fields');
  }
  await resumeAfterQuestion(ctx, {
    questionId: p.questionId,
    answer: p.answer,
    workItemId: p.workItemId,
    attempt: p.attempt ?? 0,
    forceFreshAgent: p.forceFreshAgent ?? false,
  });
});

registerJobHandler('rescore_attention', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'rescore_attention' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await rescoreOpenItems(ctx);
});

registerJobHandler('evaluate_rubric', async (db, job) => {
  const payload = job.payload as {
    pendingEvaluationId?: string;
    workItemId?: string;
    gateId?: string;
    rubricId?: string;
  };
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'evaluate_rubric' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });

  if (payload.pendingEvaluationId || payload.workItemId) {
    // Prefer bulk processor when pending id present via processPendingEvaluations
    await processPendingEvaluations(ctx, 20);
    return;
  }

  if (!payload.rubricId || !payload.workItemId) {
    await processPendingEvaluations(ctx, 20);
    return;
  }

  const result = await evaluateRubric(ctx, {
    rubricId: payload.rubricId,
    workItemId: payload.workItemId,
    skipAuthz: true,
  });

  if (result.ok) {
    await evaluateGates(ctx, {
      workItemId: payload.workItemId,
      trigger: { kind: 'on_demand' },
    });
  }
});

registerJobHandler('process_pending_evaluations', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'process_pending_evaluations' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await processPendingEvaluations(ctx, 20);
});

registerJobHandler('scrub_rubric_raw_responses', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'scrub_rubric_raw_responses' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await scrubOldRawResponses(ctx, 30);
});

registerJobHandler('dispatch_webhook_events', async (db) => {
  await migrateLegacyWebhookDispatcherCursor(db);
  const orgRows = await db.query.orgs.findMany();
  for (const org of orgRows) {
    const ctx = createContext({
      db,
      orgId: org.id,
      actor: { kind: 'system', reason: 'dispatch_webhook_events' },
      flags: createFlagReader(db),
      logger: silentLogger,
    });
    await dispatchWebhookEventsDrain(ctx, { batchSize: 200, maxBatches: 50 });
  }
});

registerJobHandler('deliver_webhooks', async (db) => {
  const org = await db.query.orgs.findFirst();
  const ctx = createContext({
    db,
    orgId: org?.id ?? '00000000-0000-7000-8000-000000000000',
    actor: { kind: 'system', reason: 'deliver_webhooks' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });
  await deliverPendingWebhooks(ctx, 50);
});

registerJobHandler('compute_analytics_daily', async (db, job) => {
  const payload = job.payload as { day?: string; orgId?: string };
  // B4: default to yesterday (complete UTC day), never incomplete "today".
  const day = payload.day
    ? new Date(`${payload.day.slice(0, 10)}T00:00:00.000Z`)
    : yesterdayUtc();
  // M23: loop every org — do not stop after the first.
  const orgRows = payload.orgId
    ? await db.query.orgs.findMany({
        where: (o, { eq }) => eq(o.id, payload.orgId!),
      })
    : await db.query.orgs.findMany();
  for (const org of orgRows) {
    const ctx = createContext({
      db,
      orgId: org.id,
      actor: { kind: 'system', reason: 'compute_analytics_daily' },
      flags: createFlagReader(db),
      logger: silentLogger,
    });
    const result = await computeDaily(ctx, day);
    if (!result.ok) throw new Error(result.error.message);
  }
});

registerJobHandler('run_estimate_backtest', async (db, job) => {
  const payload = job.payload as { projectId?: string; orgId?: string };
  // When projectId is set, resolve that project's org only — never write
  // a system-actor backtest onto every tenant.
  let orgRows: Array<{ id: string }>;
  if (payload.orgId) {
    orgRows = await db.query.orgs.findMany({
      where: (o, { eq }) => eq(o.id, payload.orgId!),
    });
  } else if (payload.projectId) {
    const project = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, payload.projectId!),
    });
    orgRows = project ? [{ id: project.orgId }] : [];
  } else {
    orgRows = await db.query.orgs.findMany();
  }
  for (const org of orgRows) {
    const ctx = createContext({
      db,
      orgId: org.id,
      actor: { kind: 'system', reason: 'run_estimate_backtest' },
      flags: createFlagReader(db),
      logger: silentLogger,
    });
    const result = await runBacktest(ctx, { projectId: payload.projectId });
    if (!result.ok) throw new Error(result.error.message);
  }
});

/** Enqueue attention maintenance jobs on cron tick. */
export async function ensureAttentionJobs(): Promise<void> {
  const db = getDb();
  const bucket = new Date().toISOString().slice(0, 16);
  await enqueueJob(db, {
    kind: 'dispatch_attention_events',
    payload: {},
    dedupeKey: `dispatch_attention_events:${bucket}`,
    priority: 8,
  }).catch(() => undefined);
  await enqueueJob(db, {
    kind: 'rescore_attention',
    payload: {},
    dedupeKey: `rescore_attention:${bucket}`,
    priority: 3,
  }).catch(() => undefined);
  const fiveMinBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  await enqueueJob(db, {
    kind: 'reconcile_attention',
    payload: {},
    dedupeKey: `reconcile_attention:${fiveMinBucket}`,
    priority: 7,
  }).catch(() => undefined);
  await enqueueJob(db, {
    kind: 'dispatch_webhook_events',
    payload: {},
    dedupeKey: `dispatch_webhook_events:${bucket}`,
    priority: 8,
  }).catch(() => undefined);
  await enqueueJob(db, {
    kind: 'deliver_webhooks',
    payload: {},
    dedupeKey: `deliver_webhooks:${bucket}`,
    priority: 8,
  }).catch(() => undefined);
}

/** Drain pending agentic evaluations each minute. */
export async function ensurePendingEvalJobs(): Promise<void> {
  const db = getDb();
  const bucket = new Date().toISOString().slice(0, 16);
  await enqueueJob(db, {
    kind: 'process_pending_evaluations',
    payload: {},
    dedupeKey: `process_pending_evaluations:${bucket}`,
    priority: 9,
  }).catch(() => undefined);
  const day = new Date().toISOString().slice(0, 10);
  await enqueueJob(db, {
    kind: 'scrub_rubric_raw_responses',
    payload: {},
    dedupeKey: `scrub_rubric_raw_responses:${day}`,
    priority: 1,
  }).catch(() => undefined);
  // B4: enqueue yesterday — the last complete UTC day.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
  await enqueueJob(db, {
    kind: 'compute_analytics_daily',
    payload: { day: yesterdayKey },
    dedupeKey: `compute_analytics_daily:${yesterdayKey}`,
    priority: 2,
  }).catch(() => undefined);
  await enqueueJob(db, {
    kind: 'run_estimate_backtest',
    payload: {},
    dedupeKey: `run_estimate_backtest:${day}`,
    priority: 2,
  }).catch(() => undefined);
}

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
