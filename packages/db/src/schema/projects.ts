import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { orgs, users } from './identity';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    nextItemNumber: integer('next_item_number').notNull().default(1),
    optionalConcepts: jsonb('optional_concepts')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ acceptanceCriteria: false, visualConfirmation: false }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    spendMicroUsd: bigint('spend_micro_usd', { mode: 'bigint' }).notNull().default(BigInt(0)),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('projects_org_id_key_unique').on(t.orgId, t.key),
    index('projects_org_id_idx').on(t.orgId),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').$type<'owner' | 'maintainer' | 'member' | 'viewer'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_id_idx').on(t.userId),
  ],
);

export const stages = pgTable(
  'stages',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    defaultOwnerClass: text('default_owner_class')
      .$type<'ai' | 'human' | 'external'>()
      .notNull(),
    isInitial: boolean('is_initial').notNull().default(false),
    isTerminal: boolean('is_terminal').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stages_project_id_key_unique').on(t.projectId, t.key),
    index('stages_project_position_idx').on(t.projectId, t.position),
  ],
);

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull().default('gray'),
    category: text('category'),
    agentSettable: boolean('agent_settable').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('labels_project_id_key_unique').on(t.projectId, t.key),
    index('labels_project_id_idx').on(t.projectId),
  ],
);
