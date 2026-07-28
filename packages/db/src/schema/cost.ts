import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { workItems } from './work-items';

export const modelPrices = pgTable(
  'model_prices',
  {
    id: uuid('id').primaryKey(),
    model: text('model').notNull(),
    inputMicroUsdPer1k: bigint('input_micro_usd_per_1k', { mode: 'bigint' }).notNull(),
    outputMicroUsdPer1k: bigint('output_micro_usd_per_1k', { mode: 'bigint' }).notNull(),
    cacheWriteMicroUsdPer1k: bigint('cache_write_micro_usd_per_1k', { mode: 'bigint' })
      .notNull()
      .default(BigInt(0)),
    cacheReadMicroUsdPer1k: bigint('cache_read_micro_usd_per_1k', { mode: 'bigint' })
      .notNull()
      .default(BigInt(0)),
    surchargeBps: integer('surcharge_bps').notNull().default(0),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('model_prices_model_effective_unique').on(t.model, t.effectiveFrom)],
);

export const budgetEvents = pgTable(
  'budget_events',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    workItemId: uuid('work_item_id').references(() => workItems.id),
    kind: text('kind').notNull(),
    scope: text('scope').$type<'item' | 'project'>().notNull(),
    before: jsonb('before').$type<Record<string, unknown>>().notNull(),
    after: jsonb('after').$type<Record<string, unknown>>().notNull(),
    actor: jsonb('actor').$type<Record<string, unknown>>().notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('budget_events_project').on(t.projectId, t.createdAt)],
);

export const costRollupChecks = pgTable('cost_rollup_checks', {
  id: uuid('id').primaryKey(),
  scope: text('scope').notNull(),
  subjectId: uuid('subject_id').notNull(),
  storedMicroUsd: bigint('stored_micro_usd', { mode: 'bigint' }).notNull(),
  recomputedMicroUsd: bigint('recomputed_micro_usd', { mode: 'bigint' }).notNull(),
  driftMicroUsd: bigint('drift_micro_usd', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CostSource = 'estimated' | 'provider' | 'admin_reconciled' | 'mixed';
