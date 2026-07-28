/**
 * Supabase-style RLS grant check: create anon/authenticated with default GRANT ALL
 * **on the fresh test database**, apply migrations, assert no table grants remain.
 *
 * B6: ALTER DEFAULT PRIVILEGES is per-database — applying it on `postgres` while
 * asserting on a different DB made both assertions pass for any migration.
 * Roles must exist before migrations run so 0016_attention.sql (and later) revokes apply.
 * Runs whenever DB_POSTGRES_URL is set (default suite — not opt-in).
 *
 * Migrations are applied via {@link execMigrations} (in-process) — no pnpm, no
 * hardcoded repo cwd. That matters for git worktrees outside the agent VM root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { closeDb, getDb } from './client';
import { execMigrations } from './exec-migrations';

const runGrants = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(runGrants)('RLS grants after estimates migrations', () => {
  const dbName = `nx_rls_${Date.now()}`;
  const baseUrl =
    process.env.DB_POSTGRES_URL?.replace(/\/[^/]+$/, '') ??
    'postgres://postgres:postgres@127.0.0.1:5432';
  const targetUrl = `${baseUrl}/${dbName}`;

  beforeAll(async () => {
    execSync(
      `psql "${baseUrl}/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${dbName};" -c "CREATE DATABASE ${dbName};"`,
      { stdio: 'inherit' },
    );
    execSync(
      `psql "${baseUrl}/${dbName}" -v ON_ERROR_STOP=1 -c "DO \\$\\$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \\$\\$;" -c "DO \\$\\$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \\$\\$;" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;"`,
      { stdio: 'inherit' },
    );
    process.env.DB_POSTGRES_URL = targetUrl;
    process.env.DB_POSTGRES_URL_NON_POOLING = targetUrl;
    process.env.DB_SSL = 'disable';
    await execMigrations(targetUrl);
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

  it('rejects TRUNCATE as anon (RLS does not filter TRUNCATE)', () => {
    let combined = '';
    try {
      combined = execSync(
        `psql "${baseUrl}/${dbName}" -v ON_ERROR_STOP=0 -c "SET ROLE anon; TRUNCATE work_items;"`,
        { encoding: 'utf8' },
      );
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      combined = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`;
    }
    expect(combined.toLowerCase()).toMatch(
      /permission denied|must be owner|does not exist|not exist/,
    );
  });
});
