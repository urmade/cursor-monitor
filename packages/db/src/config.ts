type Environment = Readonly<Record<string, string | undefined>>;

const runtimeUrlKeys = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'DB_POSTGRES_URL',
] as const;

const migrationUrlKeys = [
  'MIGRATION_DATABASE_URL',
  'DATABASE_URL_NON_POOLING',
  'POSTGRES_URL_NON_POOLING',
  'DB_POSTGRES_URL_NON_POOLING',
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

  const direct = firstValue(environment, migrationUrlKeys);
  if (direct) return postgresUrl(direct, 'Migration connection');
  return resolveDatabaseUrl(environment);
}

export function hasDatabaseUrl(
  environment: Environment = process.env,
): boolean {
  return Boolean(firstValue(environment, runtimeUrlKeys));
}
