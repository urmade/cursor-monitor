import {
  foreignKey,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs, users } from './identity';

/** Nexus-org-scoped Cursor organisation connection (metadata + optional Org Admin key). */
export const cursorOrganisations = pgTable(
  'cursor_organisations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** Public Cursor organization id (`org_…`), when known. */
    organizationId: text('organization_id'),
    baseUrl: text('base_url').notNull(),
    /** AES-GCM ciphertext (`k2:…`) for the Organization Admin API key. */
    orgApiKeyEncrypted: text('org_api_key_encrypted'),
    orgApiKeyFingerprint: text('org_api_key_fingerprint'),
    orgApiKeyHint: text('org_api_key_hint'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('cursor_organisations_org').on(t.orgId, t.createdAt),
    uniqueIndex('cursor_organisations_id_org_uidx').on(t.id, t.orgId),
    uniqueIndex('cursor_organisations_org_cursor_id')
      .on(t.orgId, t.organizationId)
      .where(sql`${t.organizationId} is not null`),
    foreignKey({
      name: 'cursor_organisations_created_by_org_fk',
      columns: [t.createdByUserId, t.orgId],
      foreignColumns: [users.id, users.orgId],
    }),
  ],
);

/** Cloud Agents / user / service-account API keys attached to a Cursor organisation. */
export const cursorOrganisationApiKeys = pgTable(
  'cursor_organisation_api_keys',
  {
    id: uuid('id').primaryKey(),
    cursorOrganisationId: uuid('cursor_organisation_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    keyKind: text('key_kind')
      .$type<'user' | 'service_account'>()
      .notNull(),
    /** AES-GCM ciphertext (`k2:…`) — never returned to the browser. */
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    apiKeyFingerprint: text('api_key_fingerprint').notNull(),
    apiKeyHint: text('api_key_hint').notNull(),
    identityLabel: text('identity_label'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('cursor_organisation_api_keys_org').on(t.orgId, t.createdAt),
    uniqueIndex('cursor_organisation_api_keys_fp_active')
      .on(t.cursorOrganisationId, t.apiKeyFingerprint)
      .where(sql`${t.revokedAt} is null`),
    foreignKey({
      name: 'cursor_organisation_api_keys_org_consistency_fk',
      columns: [t.cursorOrganisationId, t.orgId],
      foreignColumns: [cursorOrganisations.id, cursorOrganisations.orgId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'cursor_organisation_api_keys_created_by_org_fk',
      columns: [t.createdByUserId, t.orgId],
      foreignColumns: [users.id, users.orgId],
    }),
  ],
);
