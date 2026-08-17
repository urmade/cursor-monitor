import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs } from './identity';

/**
 * Per-org Monitoring project preferences: rename, hide, or merge a repository
 * into another so related repos appear as one project.
 */
export const monitoringRepoPreferences = pgTable(
  'monitoring_repo_preferences',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Canonical monitoring repo key (lowercased owner/repo). */
    repo: text('repo').notNull(),
    /** Optional display label; null keeps the canonical repo key. */
    displayName: text('display_name'),
    hidden: boolean('hidden').notNull().default(false),
    /**
     * When set, this repo is attached to another Monitoring project.
     * Canonical lowercased owner/repo of the merge target.
     */
    mergedIntoRepo: text('merged_into_repo'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('monitoring_repo_preferences_org_repo').on(
      t.orgId,
      sql`lower(btrim(${t.repo}))`,
    ),
    index('monitoring_repo_preferences_org').on(t.orgId),
    index('monitoring_repo_preferences_org_merged_into')
      .on(t.orgId, sql`lower(btrim(${t.mergedIntoRepo}))`)
      .where(sql`${t.mergedIntoRepo} is not null`),
  ],
);

/**
 * Per-org display labels for branch groups inside a Monitoring project.
 * `branchKey` stays the original branch identity; `displayName` is the label.
 */
export const monitoringBranchPreferences = pgTable(
  'monitoring_branch_preferences',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Canonical monitoring project repo key (merge root). */
    projectRepo: text('project_repo').notNull(),
    /**
     * Branch group key as shown in the details view (may be repo-prefixed
     * when repositories are merged).
     */
    branchKey: text('branch_key').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('monitoring_branch_preferences_org_project_branch').on(
      t.orgId,
      sql`lower(btrim(${t.projectRepo}))`,
      sql`lower(btrim(${t.branchKey}))`,
    ),
    index('monitoring_branch_preferences_org_project').on(
      t.orgId,
      sql`lower(btrim(${t.projectRepo}))`,
    ),
  ],
);
