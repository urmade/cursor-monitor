import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { orgs } from './identity';
import { projects, stages } from './projects';
import { workItems } from './work-items';

export const stageInstances = pgTable(
  'stage_instances',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stages.id),
    seq: integer('seq').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    outcome: text('outcome'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stage_instances_work_item_id_seq_unique').on(t.workItemId, t.seq),
    index('stage_instances_work_item_idx').on(t.workItemId, t.seq),
  ],
);

export const transitions = pgTable(
  'transitions',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    fromStageId: uuid('from_stage_id').references(() => stages.id),
    toStageId: uuid('to_stage_id')
      .notNull()
      .references(() => stages.id),
    direction: text('direction')
      .$type<'forward' | 'backward' | 'lateral' | 'initial'>()
      .notNull(),
    reasonCode: text('reason_code'),
    note: text('note'),
    actor: jsonb('actor').$type<Record<string, unknown>>().notNull(),
    gateEvaluationId: uuid('gate_evaluation_id'),
    gateBatchId: uuid('gate_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transitions_work_item_idx').on(t.workItemId, t.createdAt)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    projectId: uuid('project_id').references(() => projects.id),
    type: text('type').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    actor: jsonb('actor').$type<Record<string, unknown>>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_project_occurred').on(t.projectId, t.occurredAt),
    index('events_subject').on(t.subjectType, t.subjectId, t.occurredAt),
    index('events_org_occurred').on(t.orgId, t.occurredAt),
  ],
);
