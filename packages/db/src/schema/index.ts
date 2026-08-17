import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const hookEvents = pgTable(
  'monitor_hook_events',
  {
    id: uuid('id').primaryKey(),
    eventName: text('event_name').notNull(),
    conversationId: text('conversation_id'),
    conversationKey: text('conversation_key'),
    generationId: text('generation_id'),
    repositoryKey: text('repository_key'),
    repositoryLabel: text('repository_label'),
    gitBranch: text('git_branch'),
    workspaceRoot: text('workspace_root'),
    userEmail: text('user_email'),
    model: text('model'),
    status: text('status'),
    durationMs: integer('duration_ms'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('monitor_hook_events_repository_received').on(
      table.repositoryKey,
      table.receivedAt.desc(),
    ),
    index('monitor_hook_events_conversation_received').on(
      table.conversationKey,
      table.receivedAt.desc(),
    ),
    uniqueIndex('monitor_hook_events_generation_event')
      .on(table.generationId, table.eventName)
      .where(sql`${table.generationId} is not null`),
    check(
      'monitor_hook_duration_non_negative',
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
  ],
);

export const teamUsageEvents = pgTable(
  'monitor_team_usage_events',
  {
    fingerprint: text('fingerprint').primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    conversationId: text('conversation_id'),
    conversationKey: text('conversation_key'),
    userEmail: text('user_email'),
    model: text('model'),
    kind: text('kind'),
    teamId: integer('team_id'),
    chargedCents: doublePrecision('charged_cents'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('monitor_team_usage_conversation').on(
      table.conversationKey,
      table.occurredAt,
    ),
    index('monitor_team_usage_occurred').on(table.occurredAt.desc()),
  ],
);

export const repositoryPreferences = pgTable(
  'monitor_repository_preferences',
  {
    repositoryKey: text('repository_key').primaryKey(),
    displayName: text('display_name'),
    mergedIntoKey: text('merged_into_key'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('monitor_repository_preferences_merged')
      .on(table.mergedIntoKey)
      .where(sql`${table.mergedIntoKey} is not null`),
    check(
      'monitor_repository_not_self_merged',
      sql`${table.mergedIntoKey} is null or lower(btrim(${table.repositoryKey})) <> lower(btrim(${table.mergedIntoKey}))`,
    ),
  ],
);

export const conversationPreferences = pgTable(
  'monitor_conversation_preferences',
  {
    conversationKey: text('conversation_key').primaryKey(),
    displayName: text('display_name').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const branchPreferences = pgTable(
  'monitor_branch_preferences',
  {
    repositoryKey: text('repository_key').notNull(),
    branchKey: text('branch_key').notNull(),
    displayName: text('display_name').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'monitor_branch_preferences_pk',
      columns: [table.repositoryKey, table.branchKey],
    }),
  ],
);

export const syncRuns = pgTable(
  'monitor_sync_runs',
  {
    id: uuid('id').primaryKey(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    windowEndedAt: timestamp('window_ended_at', { withTimezone: true }).notNull(),
    fetchedCount: integer('fetched_count').notNull().default(0),
    insertedCount: integer('inserted_count').notNull().default(0),
    pages: integer('pages').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('monitor_sync_runs_started').on(table.startedAt.desc()),
    check(
      'monitor_sync_runs_status',
      sql`${table.status} in ('running', 'succeeded', 'failed', 'skipped')`,
    ),
  ],
);

export const syncLocks = pgTable('monitor_sync_locks', {
  source: text('source').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
