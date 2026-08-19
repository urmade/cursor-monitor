type Environment = Readonly<Record<string, string | undefined>>;

const runtimeUrlKeys = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'DB_POSTGRES_URL',
] as const;

const connectionFamilies = [
  {
    runtime: 'DATABASE_URL',
    migration: 'DATABASE_URL_NON_POOLING',
  },
  {
    runtime: 'POSTGRES_URL',
    migration: 'POSTGRES_URL_NON_POOLING',
  },
  {
    runtime: 'DB_POSTGRES_URL',
    migration: 'DB_POSTGRES_URL_NON_POOLING',
  },
] as const;

function firstValue(
  environment: Environment,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = environment[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function postgresUrl(value: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${source} must be a valid PostgreSQL connection URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${source} must use the postgres:// or postgresql:// scheme`);
  }
  return value;
}

export function resolveDatabaseUrl(
  environment: Environment = process.env,
): string {
  const value = firstValue(environment, runtimeUrlKeys);
  if (!value) {
    throw new Error(
      `Set ${runtimeUrlKeys.join(', ')} to a PostgreSQL connection URL`,
    );
  }
  return postgresUrl(value, 'Database connection');
}

export function resolveMigrationUrl(
  connectionUrl?: string,
  environment: Environment = process.env,
): string {
  const explicit = connectionUrl?.trim();
  if (explicit) return postgresUrl(explicit, 'Migration connection');

  const migrationOverride = environment.MIGRATION_DATABASE_URL?.trim();
  if (migrationOverride) {
    return postgresUrl(migrationOverride, 'Migration connection');
  }

  for (const family of connectionFamilies) {
    const runtime = environment[family.runtime]?.trim();
    if (!runtime) continue;
    const direct = environment[family.migration]?.trim();
    return postgresUrl(direct || runtime, 'Migration connection');
  }

  const standaloneDirect = firstValue(
    environment,
    connectionFamilies.map(({ migration }) => migration),
  );
  if (standaloneDirect) {
    return postgresUrl(standaloneDirect, 'Migration connection');
  }
  return resolveDatabaseUrl(environment);
}

export function hasDatabaseUrl(
  environment: Environment = process.env,
): boolean {
  return Boolean(firstValue(environment, runtimeUrlKeys));
}
