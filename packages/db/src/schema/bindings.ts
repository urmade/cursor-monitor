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
import { users } from './identity';
import { projects, stages } from './projects';

export const promptTemplates = pgTable(
  'prompt_templates',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prompt_templates_project_name_idx').on(t.projectId, t.name)],
);

export const automationBindings = pgTable(
  'automation_bindings',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stages.id),
    name: text('name').notNull(),
    adapter: text('adapter')
      .$type<'cloud_agent' | 'automation_webhook'>()
      .notNull(),
    condition: jsonb('condition').$type<Record<string, unknown> | null>(),
    priority: integer('priority').notNull().default(0),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    promptTemplateId: uuid('prompt_template_id').references(() => promptTemplates.id),
    enabled: boolean('enabled').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bindings_lookup').on(t.projectId, t.stageId, t.enabled, t.priority),
  ],
);
