/**
 * Defence-in-depth: Phase 6 attention tables must not grant anon/authenticated access.
 * Roles must exist before migrations run so 0016_attention.sql revokes apply (see runbook).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from './client';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('RLS grants (phase 6 attention tables)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('anon and authenticated have no table privileges on attention tables', async () => {
    const db = getDb();
    const rows = await db.execute<{ grantee: string; table_name: string }>(sql`
      select grantee::text, table_name::text
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in (
          'attention_items',
          'attention_reconciliations',
          'notification_channels',
          'notification_deliveries'
        )
        and grantee in ('anon', 'authenticated')
    `);
    const leaked = rows as unknown as Array<{ grantee: string; table_name: string }>;
    expect(leaked, JSON.stringify(leaked)).toEqual([]);
  });
});
