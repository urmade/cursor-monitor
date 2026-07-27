import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { sslOptionForUrl } from './ssl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Advisory lock key so concurrent CI migration runs cannot collide. */
const MIGRATION_LOCK_KEY = 742_019_301;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '[unparseable]';
  }
}

function withSslMode(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const isLocal =
      host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLocal || process.env.DB_SSL === 'disable') {
      u.searchParams.set('sslmode', 'disable');
      return u.toString();
    }
    if (!u.searchParams.has('sslmode')) {
      u.searchParams.set('sslmode', 'require');
    }
    return u.toString();
  } catch {
    return url;
  }
}

function isTransientProvisionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  return (
    code === 'XX000' ||
    /tenant\/user/i.test(msg) ||
    /ENOTFOUND/i.test(msg) ||
    /ECONNREFUSED/i.test(msg) ||
    /connection.*refused/i.test(msg) ||
    /timeout/i.test(msg)
  );
}

async function connectWithRetry(url: string): Promise<Sql> {
  const maxAttempts = 12;
  let lastError: unknown;
  const ssl = sslOptionForUrl(url);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const sql = postgres(url, {
      max: 1,
      connect_timeout: 15,
      ...(ssl ? { ssl } : {}),
    });
    try {
      await sql`select 1`;
      return sql;
    } catch (err) {
      lastError = err;
      await sql.end({ timeout: 1 }).catch(() => undefined);
      if (!isTransientProvisionError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = Math.min(30_000, 2_000 * attempt);
      console.warn(
        `db connect attempt ${attempt}/${maxAttempts} failed (${err instanceof Error ? err.message : err}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const rawUrl =
    process.env.DB_POSTGRES_URL_NON_POOLING ?? process.env.DB_POSTGRES_URL;
  if (!rawUrl) {
    throw new Error(
      'Set DB_POSTGRES_URL_NON_POOLING or DB_POSTGRES_URL before running migrations',
    );
  }

  const url = withSslMode(rawUrl);
  console.log(`migrating via ${redactUrl(url)}`);

  const sql = await connectWithRetry(url);
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await sql`
        create table if not exists schema_migrations (
          id text primary key,
          applied_at timestamptz not null default now()
        )
      `;

      const migrationsDir = path.resolve(__dirname, '../migrations');
      const files = (await readdir(migrationsDir))
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const id = file.replace(/\.sql$/, '');
        const existing = await sql<{ id: string }[]>`
          select id from schema_migrations where id = ${id}
        `;
        if (existing.length > 0) {
          console.log(`skip ${file} (already applied)`);
          continue;
        }

        const body = await readFile(path.join(migrationsDir, file), 'utf8');
        console.log(`apply ${file}`);
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`
            insert into schema_migrations (id) values (${id})
            on conflict (id) do nothing
          `;
        });
        console.log(`ok   ${file}`);
      }
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
