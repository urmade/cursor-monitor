import { createHash } from 'node:crypto';
import type { DatabaseAdapter, DatabaseAdapterInfo } from './adapter';
import { createPostgresAdapter } from './postgres-adapter';
import { execPostgresMigrations } from './postgres-migrations';

type Environment = Readonly<Record<string, string | undefined>>;

type DatabaseAdapterFactory = {
  readonly info: DatabaseAdapterInfo;
  configurationFingerprint(environment: Environment): string;
  create(): DatabaseAdapter;
  migrate(connectionUrl?: string): Promise<void>;
};

const postgresFactory: DatabaseAdapterFactory = {
  info: {
    id: 'postgres',
    displayName: 'PostgreSQL',
  },
  configurationFingerprint(environment) {
    const connection =
      environment.DATABASE_URL?.trim() ||
      environment.POSTGRES_URL?.trim() ||
      environment.DB_POSTGRES_URL?.trim() ||
      '<not-configured>';
    return createHash('sha256')
      .update(connection)
      .digest('hex');
  },
  create: createPostgresAdapter,
  migrate: execPostgresMigrations,
};

// Add replacement adapters here. Runtime selection always creates exactly one.
const databaseFactories: readonly DatabaseAdapterFactory[] = [postgresFactory];
const duplicateAdapterId = databaseFactories.find(
  (factory, index) =>
    databaseFactories.findIndex(
      (candidate) => candidate.info.id === factory.info.id,
    ) !== index,
);
if (duplicateAdapterId) {
  throw new Error(`Duplicate database adapter ID: ${duplicateAdapterId.info.id}`);
}

type DatabaseRuntimeState = {
  adapterId?: string;
  configurationFingerprint?: string;
  database?: DatabaseAdapter;
  closing?: Promise<void>;
};

const runtimeStateKey = Symbol.for('cursor-monitor.database-runtime.v1');

function runtimeState(): DatabaseRuntimeState {
  const runtime = globalThis as unknown as {
    [key: symbol]: DatabaseRuntimeState | undefined;
  };
  runtime[runtimeStateKey] ??= {};
  return runtime[runtimeStateKey];
}

function selectedAdapterId(environment: Environment): string {
  const configured = environment.DATABASE_ADAPTER?.trim().toLowerCase();
  if (!configured) return 'postgres';
  if (configured.includes(',') || configured.includes(';')) {
    throw new Error('DATABASE_ADAPTER must select exactly one database adapter');
  }
  return configured;
}

function selectedFactory(
  environment: Environment = process.env,
): DatabaseAdapterFactory {
  const adapterId = selectedAdapterId(environment);
  const factory = databaseFactories.find(
    (candidate) => candidate.info.id === adapterId,
  );
  if (!factory) {
    const supported = databaseFactories
      .map((candidate) => candidate.info.id)
      .join(', ');
    throw new Error(
      `Unsupported DATABASE_ADAPTER "${adapterId}". Available adapters: ${supported}`,
    );
  }
  return factory;
}

export function getDatabaseAdapterInfo(
  environment: Environment = process.env,
): DatabaseAdapterInfo {
  return selectedFactory(environment).info;
}

export function getDatabase(): DatabaseAdapter {
  const environment = process.env;
  const factory = selectedFactory(environment);
  const fingerprint = factory.configurationFingerprint(environment);
  const state = runtimeState();

  if (state.closing) {
    throw new Error('The active database adapter is still closing');
  }

  if (state.database) {
    if (
      state.adapterId !== factory.info.id ||
      state.configurationFingerprint !== fingerprint
    ) {
      throw new Error(
        'Only one database adapter and connection may be active per process',
      );
    }
    return state.database;
  }

  const database = factory.create();
  if (database.info.id !== factory.info.id) {
    throw new Error(
      `Database adapter factory "${factory.info.id}" created "${database.info.id}"`,
    );
  }
  state.adapterId = factory.info.id;
  state.configurationFingerprint = fingerprint;
  state.database = database;
  return database;
}

export async function closeDatabase(): Promise<void> {
  const state = runtimeState();
  if (state.closing) return state.closing;
  const database = state.database;
  if (!database) return;

  const closing = database.close().then(() => {
    if (state.database !== database) return;
    state.adapterId = undefined;
    state.configurationFingerprint = undefined;
    state.database = undefined;
  });
  state.closing = closing;
  try {
    await closing;
  } finally {
    if (state.closing === closing) state.closing = undefined;
  }
}

export async function migrateDatabase(connectionUrl?: string): Promise<void> {
  await selectedFactory().migrate(connectionUrl);
}
