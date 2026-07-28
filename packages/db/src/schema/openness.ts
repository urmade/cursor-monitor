import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './identity';
import { events } from './history';

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes').array().notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: bigint('use_count', { mode: 'number' }).notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('api_tokens_project').on(t.projectId, t.createdAt),
    index('api_tokens_prefix').on(t.tokenPrefix),
  ],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    url: text('url').notNull(),
    secretHash: text('secret_hash').notNull(),
    secretEncrypted: text('secret_encrypted').notNull(),
    eventTypes: text('event_types').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_endpoints_project').on(t.projectId, t.createdAt)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    eventType: text('event_type').notNull(),
    status: text('status')
      .$type<'pending' | 'delivered' | 'failed' | 'dead'>()
      .notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    requestBodyBytes: integer('request_body_bytes'),
    requestTruncated: boolean('request_truncated').notNull().default(false),
    responseStatus: integer('response_status'),
    responseBodyExcerpt: text('response_body_excerpt'),
    responseMs: integer('response_ms'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deliveries_endpoint').on(t.endpointId, t.createdAt),
  ],
);

export const apiRequestLog = pgTable(
  'api_request_log',
  {
    id: uuid('id').primaryKey(),
    tokenId: uuid('token_id').references(() => apiTokens.id),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    durationMs: integer('duration_ms'),
    requestId: text('request_id'),
    idempotencyKey: text('idempotency_key'),
    idempotencyHit: boolean('idempotency_hit').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_request_log_token').on(t.tokenId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.tokenId] })],
);
