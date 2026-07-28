import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './identity';
import { projects } from './projects';
import { workItems } from './work-items';
import { stageInstances } from './history';
import { automationBindings } from './bindings';

export const gates = pgTable(
  'gates',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    evaluator: text('evaluator')
      .$type<
        | 'field_rule'
        | 'human_approval'
        | 'budget'
        | 'agentic'
        | 'loop_budget'
        | 'visual_confirmation'
      >()
      .notNull(),
    trigger: jsonb('trigger').$type<Record<string, unknown>>().notNull(),
    appliesWhen: jsonb('applies_when').$type<Record<string, unknown> | null>(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    onFailure: text('on_failure').$type<'block' | 'warn'>().notNull().default('block'),
    enabled: boolean('enabled').notNull().default(false),
    version: integer('version').notNull().default(1),
    remediationBindingId: uuid('remediation_binding_id').references(
      () => automationBindings.id,
    ),
    remediationMaxAttempts: integer('remediation_max_attempts').notNull().default(2),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gates_lookup')
      .on(t.projectId, t.enabled)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const gateEvaluations = pgTable(
  'gate_evaluations',
  {
    id: uuid('id').primaryKey(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    gateVersion: integer('gate_version').notNull(),
    gateName: text('gate_name').notNull().default(''),
    gateConfig: jsonb('gate_config').$type<Record<string, unknown>>().notNull(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    stageInstanceId: uuid('stage_instance_id').references(() => stageInstances.id),
    trigger: jsonb('trigger').$type<Record<string, unknown>>().notNull(),
    outcome: text('outcome')
      .$type<'pass' | 'warn' | 'block' | 'skipped' | 'error'>()
      .notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    contextSnapshot: jsonb('context_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    evaluatorMeta: jsonb('evaluator_meta')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    batchId: uuid('batch_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gate_evals_item').on(t.workItemId, t.createdAt),
    index('gate_evals_batch').on(t.batchId),
    index('gate_evals_gate').on(t.gateId, t.createdAt),
    index('gate_evals_created').on(t.createdAt),
  ],
);

export const warnings = pgTable(
  'warnings',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    gateId: uuid('gate_id').references(() => gates.id),
    gateEvaluationId: uuid('gate_evaluation_id').references(() => gateEvaluations.id),
    originStageInstanceId: uuid('origin_stage_instance_id').references(
      () => stageInstances.id,
    ),
    code: text('code').notNull(),
    message: text('message').notNull(),
    status: text('status')
      .$type<'open' | 'dismissed' | 'resolved'>()
      .notNull()
      .default('open'),
    resolvedByEvaluationId: uuid('resolved_by_evaluation_id').references(
      () => gateEvaluations.id,
    ),
    dismissedByUserId: uuid('dismissed_by_user_id').references(() => users.id),
    dismissedReason: text('dismissed_reason'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('warnings_open').on(t.workItemId).where(sql`${t.status} = 'open'`),
    index('warnings_item').on(t.workItemId, t.createdAt),
    uniqueIndex('warnings_open_dedupe')
      .on(t.workItemId, t.gateId, t.code)
      .where(sql`${t.status} = 'open' and ${t.gateId} is not null`),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    gateEvaluationId: uuid('gate_evaluation_id')
      .notNull()
      .references(() => gateEvaluations.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    requestedFor: jsonb('requested_for').$type<Record<string, unknown>>().notNull(),
    status: text('status')
      .$type<'pending' | 'approved' | 'rejected' | 'withdrawn'>()
      .notNull()
      .default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('approvals_one_pending')
      .on(t.workItemId, t.gateId)
      .where(sql`${t.status} = 'pending'`),
    index('approvals_project_pending').on(t.workItemId, t.status),
  ],
);

export const interventions = pgTable(
  'interventions',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id').references(() => workItems.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(),
    actor: jsonb('actor').$type<Record<string, unknown>>().notNull(),
    target: jsonb('target').$type<Record<string, unknown>>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('interventions_item').on(t.workItemId, t.createdAt),
    index('interventions_project').on(t.projectId, t.createdAt),
  ],
);
