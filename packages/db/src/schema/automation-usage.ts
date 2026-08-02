import {
  doublePrecision,
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
import { cursorOrganisations } from './cursor-organisations';

export type AutomationUsageSource = 'teams' | 'organizations';

/** Raw Admin filtered-usage-events rows for Cloud Agent / automation spend. */
export const automationUsageEvents = pgTable(
  'automation_usage_events',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    cursorOrganisationId: uuid('cursor_organisation_id')
      .notNull()
      .references(() => cursorOrganisations.id, { onDelete: 'cascade' }),
    eventFingerprint: text('event_fingerprint').notNull(),
    source: text('source').$type<AutomationUsageSource>().notNull(),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    /** Set when the event was attributed to an automation; null for plain Cloud Agent spend. */
    automationId: text('automation_id'),
    cloudAgentId: text('cloud_agent_id'),
    teamId: integer('team_id'),
    model: text('model'),
    kind: text('kind'),
    chargedCents: doublePrecision('charged_cents'),
    userEmail: text('user_email'),
    serviceAccountId: text('service_account_id'),
    serviceAccountName: text('service_account_name'),
    targetRepo: text('target_repo'),
    durationMs: integer('duration_ms'),
    rawEvent: jsonb('raw_event').$type<Record<string, unknown>>().notNull().default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('automation_usage_events_org_fp').on(
      t.cursorOrganisationId,
      t.eventFingerprint,
    ),
    index('automation_usage_events_org_ts').on(t.orgId, t.eventTimestamp),
    index('automation_usage_events_automation').on(
      t.cursorOrganisationId,
      t.automationId,
      t.eventTimestamp,
    ),
    index('automation_usage_events_agent').on(t.cloudAgentId, t.eventTimestamp),
    index('automation_usage_events_org_agent').on(
      t.orgId,
      t.cloudAgentId,
      t.eventTimestamp,
    ),
  ],
);

/**
 * One row per cloud agent seen in Admin usage events — target repo, cost
 * (sum of chargedCents), and duration after Cloud Agents enrichment when a
 * User/Team key can see the agent.
 */
export const automationAgentRuns = pgTable(
  'automation_agent_runs',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    cursorOrganisationId: uuid('cursor_organisation_id')
      .notNull()
      .references(() => cursorOrganisations.id, { onDelete: 'cascade' }),
    automationId: text('automation_id'),
    cloudAgentId: text('cloud_agent_id').notNull(),
    targetRepo: text('target_repo'),
    durationMs: integer('duration_ms'),
    chargedCentsTotal: doublePrecision('charged_cents_total').notNull().default(0),
    eventCount: integer('event_count').notNull().default(0),
    firstEventAt: timestamp('first_event_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    agentName: text('agent_name'),
    latestModel: text('latest_model'),
    source: text('source').$type<AutomationUsageSource>().notNull(),
    enrichmentError: text('enrichment_error'),
    rawAgent: jsonb('raw_agent').$type<Record<string, unknown> | null>(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('automation_agent_runs_org_agent').on(
      t.cursorOrganisationId,
      t.cloudAgentId,
    ),
    index('automation_agent_runs_org_last').on(t.orgId, t.lastEventAt),
    index('automation_agent_runs_automation').on(
      t.cursorOrganisationId,
      t.automationId,
      t.lastEventAt,
    ),
    index('automation_agent_runs_repo').on(t.targetRepo, t.lastEventAt),
  ],
);
