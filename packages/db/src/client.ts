import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';
import { sslOptionForUrl } from './ssl';

export type Db = PostgresJsDatabase<typeof schema>;

let sqlClient: Sql | null = null;
let database: Db | null = null;

function connectionUrl(): string {
  const value = process.env.DB_POSTGRES_URL;
  if (!value) throw new Error('Missing required env var: DB_POSTGRES_URL');
  return value;
}

/** Supabase pooled runtime connection; prepared statements are unsupported. */
export function getDb(): Db {
  if (database) return database;
  const url = connectionUrl();
  const ssl = sslOptionForUrl(url);
  sqlClient = postgres(url, {
    prepare: false,
    max: 10,
    ...(ssl ? { ssl } : {}),
  });
  database = drizzle(sqlClient, { schema });
  return database;
}

export async function pingDb(): Promise<boolean> {
  try {
    const url = connectionUrl();
    const ssl = sslOptionForUrl(url);
    const client = sqlClient ?? postgres(url, {
      prepare: false,
      max: 1,
      ...(ssl ? { ssl } : {}),
    });
    await client`select 1`;
    if (!sqlClient) await client.end({ timeout: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (!sqlClient) return;
  await sqlClient.end({ timeout: 1 }).catch(() => undefined);
  sqlClient = null;
  database = null;
}
