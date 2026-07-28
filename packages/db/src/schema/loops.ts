import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { projects, stages } from './projects';
import { workItems } from './work-items';
import { stageInstances, transitions } from './history';

export type LoopTrigger = {
  kind: 'human' | 'gate' | 'report' | 'backfill' | 'system';
  by?: string;
  ref?: string;
};

export const loopReasonCodes = pgTable(
  'loop_reason_codes',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    code: text('code').notNull(),
    label: text('label').notNull(),
    requiresNote: boolean('requires_note').notNull().default(false),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('loop_reason_codes_project_code_unique').on(t.projectId, t.code),
    index('loop_reason_codes_project_idx').on(t.projectId, t.position),
  ],
);

export const loopEdges = pgTable(
  'loop_edges',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    transitionId: uuid('transition_id')
      .notNull()
      .references(() => transitions.id),
    fromStageId: uuid('from_stage_id')
      .notNull()
      .references(() => stages.id),
    toStageId: uuid('to_stage_id')
      .notNull()
      .references(() => stages.id),
    toStageInstanceId: uuid('to_stage_instance_id').references(
      () => stageInstances.id,
    ),
    reasonCode: text('reason_code').notNull(),
    note: text('note'),
    trigger: jsonb('trigger').$type<LoopTrigger>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' }),
    durationMs: bigint('duration_ms', { mode: 'bigint' }),
    costComplete: boolean('cost_complete').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('loop_edges_transition_id_unique').on(t.transitionId),
    index('loop_edges_item').on(t.workItemId, t.occurredAt),
    index('loop_edges_pair').on(t.fromStageId, t.toStageId),
  ],
);
