import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { labels, projects, stages } from './projects';

export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    number: integer('number').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    complexity: text('complexity').$type<'low' | 'medium' | 'high'>(),
    currentStageId: uuid('current_stage_id')
      .notNull()
      .references(() => stages.id),
    currentStageInstanceId: uuid('current_stage_instance_id'),
    currentSpecVersionId: uuid('current_spec_version_id'),
    ownerClass: text('owner_class')
      .$type<'ai' | 'human' | 'external'>()
      .notNull()
      .default('human'),
    externallyBlockedReason: text('externally_blocked_reason'),
    parentWorkItemId: uuid('parent_work_item_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    currentRunId: uuid('current_run_id'),
    lastReportId: uuid('last_report_id'),
    budgetMicroUsd: bigint('budget_micro_usd', { mode: 'bigint' }),
    budgetOverridden: boolean('budget_overridden').notNull().default(false),
    spendMicroUsd: bigint('spend_micro_usd', { mode: 'bigint' }).notNull().default(BigInt(0)),
    spendSource: text('spend_source').$type<
      'estimated' | 'provider' | 'admin_reconciled' | 'mixed'
    >(),
    pausedReason: text('paused_reason'),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('work_items_project_id_number_unique').on(t.projectId, t.number),
    unique('work_items_project_id_key_unique').on(t.projectId, t.key),
    index('work_items_project_stage_idx').on(t.projectId, t.currentStageId),
    index('work_items_project_created_idx').on(t.projectId, t.createdAt),
  ],
);

export const workItemLabels = pgTable(
  'work_item_labels',
  {
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id),
    setByActor: jsonb('set_by_actor').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.labelId] }),
    index('work_item_labels_label_id_idx').on(t.labelId),
  ],
);

export const specVersions = pgTable(
  'spec_versions',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    version: integer('version').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    authoredBy: jsonb('authored_by').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('spec_versions_work_item_id_version_unique').on(t.workItemId, t.version),
    index('spec_versions_work_item_idx').on(t.workItemId, t.version),
  ],
);

export const statusOverrides = pgTable(
  'status_overrides',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    status: text('status').notNull(),
    reason: text('reason').notNull(),
    setByUserId: uuid('set_by_user_id')
      .notNull()
      .references(() => users.id),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('status_overrides_work_item_idx').on(t.workItemId)],
);
