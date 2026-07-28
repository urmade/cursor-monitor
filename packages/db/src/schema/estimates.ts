import {
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  index,
} from 'drizzle-orm/pg-core';
import { orgs } from './identity';
import { projects } from './projects';

export const estimateCache = pgTable('estimate_cache', {
  key: text('key').primaryKey(),
  estimate: jsonb('estimate').$type<Record<string, unknown>>().notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const estimateBacktests = pgTable(
  'estimate_backtests',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    projectId: uuid('project_id').references(() => projects.id),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    sampleSize: integer('sample_size').notNull(),
    coverage: numeric('coverage', { precision: 4, scale: 3 }).notNull(),
    p50Bias: numeric('p50_bias', { precision: 14, scale: 3 }).notNull(),
    mape: numeric('mape', { precision: 14, scale: 3 }).notNull(),
    byComplexity: jsonb('by_complexity').$type<Record<string, unknown>>().notNull(),
    byTier: jsonb('by_tier').$type<Record<string, unknown>>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    interpretation: text('interpretation').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('estimate_backtests_org_ran').on(t.orgId, t.ranAt),
    index('estimate_backtests_project_ran').on(t.projectId, t.ranAt),
  ],
);

export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    day: date('day').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.projectId] }),
    index('analytics_daily_project_day').on(t.projectId, t.day),
  ],
);
