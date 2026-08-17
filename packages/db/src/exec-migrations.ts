import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { sslOptionForUrl } from './ssl';

const directory = path.dirname(fileURLToPath(import.meta.url));
const lockKey = 1_987_451_621;

export async function execMigrations(connectionUrl?: string): Promise<void> {
  const url =
    connectionUrl ??
    process.env.DB_POSTGRES_URL_NON_POOLING ??
    process.env.DB_POSTGRES_URL;
  if (!url) {
    throw new Error(
      'Set DB_POSTGRES_URL_NON_POOLING or DB_POSTGRES_URL before running migrations',
    );
  }

  const ssl = sslOptionForUrl(url);
  const client = postgres(url, {
    max: 1,
    connect_timeout: 15,
    ...(ssl ? { ssl } : {}),
  });
  try {
    await client`select pg_advisory_lock(${lockKey})`;
    try {
      await client`
        create table if not exists schema_migrations (
          id text primary key,
          applied_at timestamptz not null default now()
        )
      `;
      const migrations = (
        await readdir(path.resolve(directory, '../migrations'))
      )
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        const id = file.slice(0, -4);
        const existing = await client<{ id: string }[]>`
          select id from schema_migrations where id = ${id}
        `;
        if (existing.length > 0) continue;
        const body = await readFile(
          path.resolve(directory, '../migrations', file),
          'utf8',
        );
        await client.begin(async (transaction) => {
          await transaction.unsafe(body);
          await transaction`
            insert into schema_migrations (id) values (${id})
          `;
        });
      }
    } finally {
      await client`select pg_advisory_unlock(${lockKey})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  execMigrations().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
