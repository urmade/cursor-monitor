import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index';
import { sslOptionForUrl } from './ssl';

export type Db = PostgresJsDatabase<typeof schema>;

let pooledSql: Sql | null = null;
let pooledDb: Db | null = null;
let directSql: Sql | null = null;
let directDb: Db | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/** Pooled runtime connection (Supavisor transaction mode). prepare:false required. */
export function getDb(): Db {
  if (pooledDb) return pooledDb;
  const url = requireEnv('DB_POSTGRES_URL');
  const ssl = sslOptionForUrl(url);
  pooledSql = postgres(url, {
    prepare: false,
    max: 10,
    ...(ssl ? { ssl } : {}),
  });
  pooledDb = drizzle(pooledSql, { schema });
  return pooledDb;
}

/** Direct (non-pooling) connection for migrations and long transactions. */
export function getDirectDb(): Db {
  if (directDb) return directDb;
  const url =
    process.env.DB_POSTGRES_URL_NON_POOLING ?? requireEnv('DB_POSTGRES_URL');
  const ssl = sslOptionForUrl(url);
  directSql = postgres(url, {
    max: 1,
    ...(ssl ? { ssl } : {}),
  });
  directDb = drizzle(directSql, { schema });
  return directDb;
}

export async function pingDb(): Promise<boolean> {
  try {
    const url = requireEnv('DB_POSTGRES_URL');
    const ssl = sslOptionForUrl(url);
    const sql =
      pooledSql ??
      postgres(url, { prepare: false, max: 1, ...(ssl ? { ssl } : {}) });
    await sql`select 1`;
    if (!pooledSql) await sql.end({ timeout: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function getMigrationVersion(): Promise<string | null> {
  try {
    const url =
      process.env.DB_POSTGRES_URL_NON_POOLING ?? requireEnv('DB_POSTGRES_URL');
    const ssl = sslOptionForUrl(url);
    const sql = postgres(url, {
      prepare: false,
      max: 1,
      ...(ssl ? { ssl } : {}),
    });
    try {
      const rows = await sql<{ id: string }[]>`
        select id from schema_migrations order by applied_at desc limit 1
      `;
      return rows[0]?.id ?? null;
    } finally {
      await sql.end({ timeout: 1 });
    }
  } catch {
    return null;
  }
}

/** Reset cached connections — used by tests. */
export async function closeDb(): Promise<void> {
  if (pooledSql) {
    await pooledSql.end({ timeout: 1 }).catch(() => undefined);
    pooledSql = null;
    pooledDb = null;
  }
  if (directSql) {
    await directSql.end({ timeout: 1 }).catch(() => undefined);
    directSql = null;
    directDb = null;
  }
}
