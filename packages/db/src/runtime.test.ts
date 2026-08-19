import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  getDatabase,
  getDatabaseAdapterInfo,
  migrateDatabase,
} from './runtime';

const previous = {
  adapter: process.env.DATABASE_ADAPTER,
  url: process.env.DATABASE_URL,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  await closeDatabase();
  restore('DATABASE_ADAPTER', previous.adapter);
  restore('DATABASE_URL', previous.url);
});

describe('single database adapter selection', () => {
  it('selects PostgreSQL by default without initializing a connection', () => {
    expect(getDatabaseAdapterInfo({})).toEqual({
      id: 'postgres',
      displayName: 'PostgreSQL',
    });
  });

  it('rejects unknown or multiple adapter selections', () => {
    expect(() =>
      getDatabaseAdapterInfo({ DATABASE_ADAPTER: 'unknown' }),
    ).toThrow(/Unsupported DATABASE_ADAPTER/);
    expect(() =>
      getDatabaseAdapterInfo({ DATABASE_ADAPTER: 'postgres,other' }),
    ).toThrow(/exactly one/);
  });

  it('returns one adapter for one connection per process', () => {
    process.env.DATABASE_ADAPTER = 'postgres';
    process.env.DATABASE_URL = 'postgres://database.example/monitor';
    expect(getDatabase()).toBe(getDatabase());
    process.env.DATABASE_URL = 'postgres://other.example/monitor';
    expect(() => getDatabase()).toThrow(
      /Only one database adapter and connection/,
    );
  });

  it('allows a new selection only after the active adapter closes', async () => {
    process.env.DATABASE_URL = 'postgres://database.example/monitor';
    const first = getDatabase();
    await closeDatabase();
    process.env.DATABASE_URL = 'postgres://other.example/monitor';
    const second = getDatabase();
    expect(second).not.toBe(first);
  });

  it('blocks replacement until the active adapter finishes closing', async () => {
    process.env.DATABASE_URL = 'postgres://database.example/monitor';
    const database = getDatabase();
    let finishClose!: () => void;
    database.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );

    const closing = closeDatabase();
    expect(() => getDatabase()).toThrow(/still closing/);
    finishClose();
    await closing;
    expect(getDatabase()).not.toBe(database);
  });

  it('routes migrations through the same adapter selection', async () => {
    process.env.DATABASE_ADAPTER = 'unknown';
    await expect(migrateDatabase()).rejects.toThrow(
      /Unsupported DATABASE_ADAPTER/,
    );
  });
});
