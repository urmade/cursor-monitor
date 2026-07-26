import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index';

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
  pooledSql = postgres(url, { prepare: false, max: 10, ssl: 'require' });
  pooledDb = drizzle(pooledSql, { schema });
  return pooledDb;
}

/** Direct (non-pooling) connection for migrations and long transactions. */
export function getDirectDb(): Db {
  if (directDb) return directDb;
  const url =
    process.env.DB_POSTGRES_URL_NON_POOLING ?? requireEnv('DB_POSTGRES_URL');
  directSql = postgres(url, { max: 1, ssl: 'require' });
  directDb = drizzle(directSql, { schema });
  return directDb;
}

export async function pingDb(): Promise<boolean> {
  try {
    const sql = pooledSql ?? postgres(requireEnv('DB_POSTGRES_URL'), { prepare: false, max: 1 });
    await sql`select 1`;
    if (!pooledSql) await sql.end({ timeout: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function getMigrationVersion(): Promise<string | null> {
  try {
    const sql = postgres(
      process.env.DB_POSTGRES_URL_NON_POOLING ?? requireEnv('DB_POSTGRES_URL'),
      { prepare: false, max: 1 },
    );
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
