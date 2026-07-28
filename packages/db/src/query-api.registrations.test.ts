/**
 * Every `ctx.db.query.<relation>` used in packages/core must be registered on the
 * Drizzle schema passed to `drizzle()`. Missing exports cause `undefined` at runtime.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, closeDb } from './client';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

/** Relations referenced via `ctx.db.query.*` in packages/core (keep in sync). */
const CORE_QUERY_RELATIONS = [
  'orgs',
  'users',
  'projects',
  'projectMembers',
  'stages',
  'labels',
  'workItems',
  'specVersions',
  'stageInstances',
  'transitions',
  'events',
  'automationBindings',
  'promptTemplates',
  'runs',
  'questions',
  'artifactRefs',
  'stageReports',
  'gates',
  'gateEvaluations',
  'warnings',
  'approvals',
  'interventions',
  'budgetEvents',
  'loopReasonCodes',
  'loopEdges',
  'statusOverrides',
  'appMeta',
  'featureFlags',
  'attentionItems',
  'notificationChannels',
  'notificationDeliveries',
  'attentionReconciliations',
  'rubrics',
  'rubricVerdicts',
  'rubricGoldenCases',
  'rubricRegressionRuns',
  'pendingEvaluations',
] as const;

describe.runIf(hasDb)('drizzle relational query API', () => {
  afterAll(async () => {
    await closeDb();
  });

  for (const relation of CORE_QUERY_RELATIONS) {
    it(`registers db.query.${relation}`, async () => {
      const db = getDb();
      const q = db.query as Record<string, { findMany: (opts: object) => Promise<unknown> }>;
      const api = q[relation];
      expect(api, `schema index missing export for ${relation}`).toBeDefined();
      await api!.findMany({ limit: 0 });
    });
  }
});
