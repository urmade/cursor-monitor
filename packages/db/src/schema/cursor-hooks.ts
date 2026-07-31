import {
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
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
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
