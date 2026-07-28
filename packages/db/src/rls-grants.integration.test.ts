/**
 * Supabase-style RLS grant check: create anon/authenticated with default GRANT ALL,
 * apply migrations, assert no table grants remain (except schema_migrations).
 * Roles must exist before migrations run so 0016_attention.sql revokes apply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { closeDb, getDb } from './client';

const runGrants =
  process.env.RUN_RLS_GRANTS_TEST === '1' && Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(runGrants)('RLS grants after openness migrations', () => {
  const dbName = `nx_rls_${Date.now()}`;
  const baseUrl =
    process.env.DB_POSTGRES_URL?.replace(/\/[^/]+$/, '') ??
    'postgres://postgres:postgres@127.0.0.1:5432';

  beforeAll(() => {
    execSync(
      `psql "${baseUrl}/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${dbName};" -c "CREATE DATABASE ${dbName};"`,
      { stdio: 'inherit' },
    );
    execSync(
      `psql "${baseUrl}/${dbName}" -v ON_ERROR_STOP=1 -c "DO \\$\\$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \\$\\$;" -c "DO \\$\\$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \\$\\$;" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;"`,
      { stdio: 'inherit'},
    );
    process.env.DB_POSTGRES_URL = `${baseUrl}/${dbName}`;
    process.env.DB_SSL = 'disable';
    execSync('pnpm db:exec-migrations', {
      cwd: '/workspace',
      stdio: 'inherit',
      env: { ...process.env },
    });
  });

  afterAll(async () => {
    await closeDb();
    execSync(`psql "${baseUrl}/postgres" -c "DROP DATABASE IF EXISTS ${dbName};"`, {
      stdio: 'inherit',
    });
  });

  it('revokes anon/authenticated table grants on app tables', async () => {
    const db = getDb();
    const rows = await db.execute(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee IN ('anon','authenticated') AND table_schema = 'public'
      ORDER BY 1,2
    `);
    const grants = rows as unknown as Array<{
      grantee: string;
      table_name: string;
      privilege_type: string;
    }>;
    const leaked = grants.filter((g) => g.table_name !== 'schema_migrations');
    expect(leaked).toEqual([]);
  });
});
