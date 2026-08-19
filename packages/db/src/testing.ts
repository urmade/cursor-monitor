import type { DatabaseAdapter } from './adapter';

export type DatabaseAdapterStubOverrides = Partial<
  Pick<DatabaseAdapter, 'info' | 'ping' | 'close'>
> & {
  hooks?: Partial<DatabaseAdapter['hooks']>;
  usage?: Partial<DatabaseAdapter['usage']>;
  repositoryPreferences?: Partial<DatabaseAdapter['repositoryPreferences']>;
  conversationPreferences?: Partial<
    DatabaseAdapter['conversationPreferences']
  >;
  branchPreferences?: Partial<DatabaseAdapter['branchPreferences']>;
  sync?: Partial<DatabaseAdapter['sync']>;
};

function notImplemented(operation: string): never {
  throw new Error(`Database test adapter does not implement ${operation}`);
}

export function createDatabaseAdapterStub(
  overrides: DatabaseAdapterStubOverrides = {},
): DatabaseAdapter {
  return {
    info: overrides.info ?? {
      id: 'test',
      displayName: 'Test database',
    },
    ping: overrides.ping ?? (async () => true),
    close: overrides.close ?? (async () => undefined),
    hooks: {
      insert: async () => notImplemented('hooks.insert'),
      listRecent: async () => notImplemented('hooks.listRecent'),
      listPayloads: async () => notImplemented('hooks.listPayloads'),
      count: async () => notImplemented('hooks.count'),
      ...overrides.hooks,
    },
    usage: {
      insertDeduplicated: async () =>
        notImplemented('usage.insertDeduplicated'),
      listRecent: async () => notImplemented('usage.listRecent'),
      count: async () => notImplemented('usage.count'),
      ...overrides.usage,
    },
    repositoryPreferences: {
      list: async () => notImplemented('repositoryPreferences.list'),
      setDisplayName: async () =>
        notImplemented('repositoryPreferences.setDisplayName'),
      merge: async () => notImplemented('repositoryPreferences.merge'),
      clearMerge: async () =>
        notImplemented('repositoryPreferences.clearMerge'),
      ...overrides.repositoryPreferences,
    },
    conversationPreferences: {
      list: async () => notImplemented('conversationPreferences.list'),
      setDisplayName: async () =>
        notImplemented('conversationPreferences.setDisplayName'),
      delete: async () => notImplemented('conversationPreferences.delete'),
      ...overrides.conversationPreferences,
    },
    branchPreferences: {
      list: async () => notImplemented('branchPreferences.list'),
      setDisplayName: async () =>
        notImplemented('branchPreferences.setDisplayName'),
      delete: async () => notImplemented('branchPreferences.delete'),
      ...overrides.branchPreferences,
    },
    sync: {
      latestSuccessfulWindowEnd: async () =>
        notImplemented('sync.latestSuccessfulWindowEnd'),
      insertRun: async () => notImplemented('sync.insertRun'),
      updateRun: async () => notImplemented('sync.updateRun'),
      listRecentRuns: async () => notImplemented('sync.listRecentRuns'),
      tryAcquireLease: async () => notImplemented('sync.tryAcquireLease'),
      releaseLease: async () => notImplemented('sync.releaseLease'),
      ...overrides.sync,
    },
  };
}
