import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
} from 'drizzle-orm/pg-core';

/** Telemetry rows posted by Cursor `stop` hooks (any consuming project). */
export const cursorStopHookEvents = pgTable(
  'cursor_stop_hook_events',
  {
    id: uuid('id').primaryKey(),
    conversationId: text('conversation_id'),
    generationId: text('generation_id'),
    model: text('model'),
    modelId: text('model_id'),
    hookEventName: text('hook_event_name'),
    cursorVersion: text('cursor_version'),
    userEmail: text('user_email'),
    transcriptPath: text('transcript_path'),
    status: text('status'),
    loopCount: integer('loop_count'),
    workspaceRoots: jsonb('workspace_roots')
      .$type<unknown[]>()
      .notNull()
      .default([]),
    workspaceRoot: text('workspace_root'),
    repo: text('repo'),
    gitBranch: text('git_branch'),
    modelParams: jsonb('model_params').$type<
      Array<{ id: string; value: string }> | null
    >(),
    /** chargedCents from Cursor Team Admin filtered-usage-events */
    chargedCents: doublePrecision('charged_cents'),
    costSource: text('cost_source'),
    costLookupError: text('cost_lookup_error'),
    usageEvent: jsonb('usage_event').$type<Record<string, unknown> | null>(),
    /** Last attempt to resolve cost from the Team usage API (delayed cadence). */
    costLookedUpAt: timestamp('cost_looked_up_at', { withTimezone: true }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('cursor_stop_hook_events_received').on(t.receivedAt),
    index('cursor_stop_hook_events_conversation').on(
      t.conversationId,
      t.receivedAt,
    ),
    index('cursor_stop_hook_events_user_repo').on(
      t.userEmail,
      t.repo,
      t.receivedAt,
    ),
    index('cursor_stop_hook_events_repo_conversation').on(
      t.repo,
      t.conversationId,
      t.receivedAt,
    ),
  ],
);
