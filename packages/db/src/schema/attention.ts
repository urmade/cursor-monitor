import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { workItems } from './work-items';

export const attentionItems = pgTable(
  'attention_items',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    kind: text('kind').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    title: text('title').notNull(),
    why: text('why').notNull(),
    askedOf: text('asked_of').notNull().default('anyone'),
    status: text('status').notNull().default('open'),
    score: integer('score').notNull().default(0),
    scoreExplain: jsonb('score_explain')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actions: jsonb('actions')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: jsonb('resolved_by').$type<Record<string, unknown>>(),
    resolution: text('resolution'),
  },
  (t) => [
    index('attention_queue').on(t.projectId, t.status, t.score),
    index('attention_work_item').on(t.workItemId, t.status),
  ],
);

export const attentionReconciliations = pgTable('attention_reconciliations', {
  id: uuid('id').primaryKey(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  created: integer('created').notNull(),
  resolved: integer('resolved').notNull(),
  drift: integer('drift').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(),
    secretKey: text('secret_key').notNull(),
    minKindSeverity: text('min_kind_severity').notNull().default('all'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_channels_project').on(t.projectId)],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id),
    attentionItemId: uuid('attention_item_id').references(() => attentionItems.id),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_deliveries_channel').on(t.channelId, t.createdAt)],
);
