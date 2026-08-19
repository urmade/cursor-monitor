import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { resolveDatabaseUrl } from './config';
import * as schema from './schema';
import { sslOptionForUrl } from './ssl';

export type Db = PostgresJsDatabase<typeof schema>;

let sqlClient: Sql | null = null;
let database: Db | null = null;

/** Generic PostgreSQL runtime connection, safe for transaction-mode poolers. */
export function getDb(): Db {
  if (database) return database;
  const url = resolveDatabaseUrl();
  const ssl = sslOptionForUrl(url);
  sqlClient = postgres(url, {
    prepare: false,
    max: 10,
    ...(ssl === undefined ? {} : { ssl }),
  });
  database = drizzle(sqlClient, { schema });
  return database;
}

export async function pingDb(): Promise<boolean> {
  try {
    const url = resolveDatabaseUrl();
    const ssl = sslOptionForUrl(url);
    const client = sqlClient ?? postgres(url, {
      prepare: false,
      max: 1,
      ...(ssl === undefined ? {} : { ssl }),
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
