import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './identity';
import { projects } from './projects';
import { workItems } from './work-items';
import { gateEvaluations } from './gates';

export const rubrics = pgTable(
  'rubrics',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    target: text('target').$type<'spec' | 'stage_report'>().notNull(),
    question: text('question').notNull(),
    criteria: jsonb('criteria').$type<Record<string, unknown>[]>().notNull(),
    passWhen: text('pass_when').notNull(),
    blockWhen: text('block_when').notNull(),
    guidance: text('guidance').notNull().default(''),
    model: text('model').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull().default(1200),
    uncertaintyPolicy: text('uncertainty_policy')
      .$type<'warn' | 'pass' | 'block'>()
      .notNull()
      .default('warn'),
    enabled: boolean('enabled').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('rubrics_project_name_version').on(t.projectId, t.name, t.version),
    index('rubrics_project_idx')
      .on(t.projectId)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const rubricVerdicts = pgTable(
  'rubric_verdicts',
  {
    id: uuid('id').primaryKey(),
    rubricId: uuid('rubric_id')
      .notNull()
      .references(() => rubrics.id),
    rubricVersion: integer('rubric_version').notNull(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    gateEvaluationId: uuid('gate_evaluation_id').references(() => gateEvaluations.id),
    targetKind: text('target_kind').$type<'spec' | 'stage_report'>().notNull(),
    targetRef: uuid('target_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    outcome: text('outcome').$type<'pass' | 'warn' | 'block' | 'error'>().notNull(),
    /** Model outcome before uncertainty policy (null for infra-error rows). */
    modelOutcome: text('model_outcome').$type<'pass' | 'warn' | 'block'>(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    headline: text('headline').notNull(),
    criteria: jsonb('criteria').$type<Record<string, unknown>[]>().notNull(),
    suggestedRemediation: text('suggested_remediation'),
    model: text('model').notNull(),
    tokens: jsonb('tokens').$type<Record<string, unknown>>(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' }),
    durationMs: integer('duration_ms'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    rawResponse: jsonb('raw_response').$type<Record<string, unknown> | null>(),
    runId: uuid('run_id'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rubric_verdicts_cache').on(t.rubricId, t.rubricVersion, t.contentHash),
    index('rubric_verdicts_item').on(t.workItemId, t.createdAt),
    index('rubric_verdicts_gate_eval').on(t.gateEvaluationId),
  ],
);

export const rubricGoldenCases = pgTable(
  'rubric_golden_cases',
  {
    id: uuid('id').primaryKey(),
    rubricId: uuid('rubric_id')
      .notNull()
      .references(() => rubrics.id),
    label: text('label').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    expectedOutcome: text('expected_outcome')
      .$type<'pass' | 'warn' | 'block'>()
      .notNull(),
    note: text('note'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rubric_golden_cases_rubric').on(t.rubricId, t.createdAt)],
);

export const rubricRegressionRuns = pgTable(
  'rubric_regression_runs',
  {
    id: uuid('id').primaryKey(),
    rubricId: uuid('rubric_id')
      .notNull()
      .references(() => rubrics.id),
    rubricVersion: integer('rubric_version').notNull(),
    total: integer('total').notNull(),
    matched: integer('matched').notNull(),
    results: jsonb('results').$type<Record<string, unknown>[]>().notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rubric_regression_runs_rubric').on(t.rubricId, t.rubricVersion, t.createdAt),
  ],
);

/** Pending async agentic evaluations (awaiting_evaluation). */
export const pendingEvaluations = pgTable(
  'pending_evaluations',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    gateId: uuid('gate_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    trigger: jsonb('trigger').$type<Record<string, unknown>>().notNull(),
    status: text('status')
      .$type<'pending' | 'running' | 'completed' | 'failed'>()
      .notNull()
      .default('pending'),
    jobId: uuid('job_id'),
    verdictId: uuid('verdict_id'),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('pending_evaluations_open')
      .on(t.workItemId, t.gateId)
      .where(sql`${t.status} in ('pending','running')`),
    index('pending_evaluations_item').on(t.workItemId, t.status),
  ],
);
