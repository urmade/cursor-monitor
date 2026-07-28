import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { modelPrices } from './cost';
import { users } from './identity';
import { projects } from './projects';
import { workItems } from './work-items';
import { stageInstances } from './history';
import { automationBindings, promptTemplates } from './bindings';

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    stageInstanceId: uuid('stage_instance_id')
      .notNull()
      .references(() => stageInstances.id),
    bindingId: uuid('binding_id').references(() => automationBindings.id),
    promptTemplateId: uuid('prompt_template_id').references(() => promptTemplates.id),
    adapter: text('adapter')
      .$type<'cloud_agent' | 'automation_webhook' | 'internal_llm'>()
      .notNull(),
    trigger: jsonb('trigger').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    nonce: text('nonce').notNull().unique(),
    attempt: integer('attempt').notNull().default(1),
    providerAgentId: text('provider_agent_id'),
    providerRunId: text('provider_run_id'),
    providerUrl: text('provider_url'),
    model: text('model'),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms'),
    tokens: jsonb('tokens').$type<Record<string, unknown>>(),
    usageUuid: text('usage_uuid'),
    gitSnapshot: jsonb('git_snapshot').$type<Record<string, unknown> | unknown[]>(),
    outcome: text('outcome'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    pollAttempts: integer('poll_attempts').notNull().default(0),
    costEstimateMicroUsd: bigint('cost_estimate_micro_usd', { mode: 'bigint' }),
    costActualMicroUsd: bigint('cost_actual_micro_usd', { mode: 'bigint' }),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' }),
    costSource: text('cost_source').$type<
      'estimated' | 'provider' | 'admin_reconciled' | 'mixed'
    >(),
    priceRowId: uuid('price_row_id').references(() => modelPrices.id),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    allocationMethod: text('allocation_method'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_active').on(t.status, t.deadlineAt),
    index('runs_work_item_created').on(t.workItemId, t.createdAt),
    index('runs_provider_agent').on(t.providerAgentId),
  ],
);

export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    runId: uuid('run_id').references(() => runs.id),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mcp_tokens_run_idx').on(t.runId),
    index('mcp_tokens_work_item_idx').on(t.workItemId),
  ],
);

export const stageReports = pgTable(
  'stage_reports',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    stageInstanceId: uuid('stage_instance_id')
      .notNull()
      .references(() => stageInstances.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    outcome: text('outcome').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    headline: text('headline').notNull(),
    summary: text('summary').notNull().default(''),
    assumptions: jsonb('assumptions').$type<string[]>().notNull().default([]),
    notVerified: jsonb('not_verified').$type<string[]>().notNull().default([]),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stage_reports_run_id_unique').on(t.runId),
    index('stage_reports_work_item_idx').on(t.workItemId, t.createdAt),
  ],
);

export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    runId: uuid('run_id').references(() => runs.id),
    stageInstanceId: uuid('stage_instance_id').references(() => stageInstances.id),
    text: text('text').notNull(),
    options: jsonb('options').$type<string[]>().notNull().default([]),
    blocking: boolean('blocking').notNull().default(false),
    status: text('status')
      .$type<'open' | 'answered' | 'withdrawn' | 'superseded'>()
      .notNull()
      .default('open'),
    answer: text('answer'),
    answeredByUserId: uuid('answered_by_user_id').references(() => users.id),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    resumeRunId: uuid('resume_run_id').references(() => runs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('questions_open').on(t.workItemId)],
);

export const artifactRefs = pgTable(
  'artifact_refs',
  {
    id: uuid('id').primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id),
    runId: uuid('run_id').references(() => runs.id),
    kind: text('kind').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('artifact_refs_work_item_idx').on(t.workItemId, t.createdAt),
    index('artifact_refs_run_idx').on(t.runId),
  ],
);

export const mcpCallLog = pgTable(
  'mcp_call_log',
  {
    id: uuid('id').primaryKey(),
    tokenId: uuid('token_id').references(() => mcpTokens.id),
    runId: uuid('run_id').references(() => runs.id),
    workItemId: uuid('work_item_id').references(() => workItems.id),
    tool: text('tool').notNull(),
    ok: boolean('ok').notNull(),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
    requestBytes: integer('request_bytes'),
    responseBytes: integer('response_bytes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mcp_call_log_run_idx').on(t.runId, t.createdAt),
    index('mcp_call_log_created_idx').on(t.createdAt),
  ],
);
