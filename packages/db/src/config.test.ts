import { describe, expect, it } from 'vitest';
import {
  hasDatabaseUrl,
  resolveDatabaseUrl,
  resolveMigrationUrl,
} from './config';
import { sslOptionForUrl } from './ssl';

describe('database configuration', () => {
  it('prefers the provider-neutral runtime URL', () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: ' postgres://app:secret@db.example/monitor ',
        POSTGRES_URL: 'postgres://provider/monitor',
        DB_POSTGRES_URL: 'postgres://legacy/monitor',
      }),
    ).toBe('postgres://app:secret@db.example/monitor');
  });

  it('supports common provider aliases for existing deployments', () => {
    expect(
      resolveDatabaseUrl({
        DB_POSTGRES_URL: 'postgresql://legacy.example/monitor',
      }),
    ).toBe('postgresql://legacy.example/monitor');
    expect(
      resolveDatabaseUrl({
        POSTGRES_URL: 'postgres://provider.example/monitor',
      }),
    ).toBe('postgres://provider.example/monitor');
  });

  it('uses a direct migration URL when supplied and otherwise uses runtime', () => {
    expect(
      resolveMigrationUrl(undefined, {
        DATABASE_URL: 'postgres://runtime.example/monitor',
        MIGRATION_DATABASE_URL: 'postgres://direct.example/monitor',
      }),
    ).toBe('postgres://direct.example/monitor');
    expect(
      resolveMigrationUrl(undefined, {
        DATABASE_URL: 'postgres://runtime.example/monitor',
      }),
    ).toBe('postgres://runtime.example/monitor');
  });

  it('accepts an explicit migration URL over environment configuration', () => {
    expect(
      resolveMigrationUrl(' postgres://override.example/monitor ', {
        MIGRATION_DATABASE_URL: 'postgres://direct.example/monitor',
      }),
    ).toBe('postgres://override.example/monitor');
  });

  it('rejects missing and non-PostgreSQL URLs', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
    expect(() =>
      resolveDatabaseUrl({ DATABASE_URL: 'mysql://db.example/monitor' }),
    ).toThrow(/postgres/);
  });

  it('reports whether any supported runtime URL is present', () => {
    expect(hasDatabaseUrl({ DATABASE_URL: 'postgres://db/monitor' })).toBe(true);
    expect(hasDatabaseUrl({ DB_POSTGRES_URL: '   ' })).toBe(false);
  });
});

describe('PostgreSQL TLS configuration', () => {
  it('disables TLS for local databases by default', () => {
    expect(sslOptionForUrl('postgres://localhost/monitor', {})).toBe(false);
    expect(sslOptionForUrl('postgres://[::1]/monitor', {})).toBe(false);
  });

  it('requires TLS for remote databases by default', () => {
    expect(sslOptionForUrl('postgres://db.example/monitor', {})).toBe('require');
  });

  it('honors standard URL and environment SSL settings', () => {
    expect(
      sslOptionForUrl('postgres://db.example/monitor?sslmode=disable', {}),
    ).toBe(false);
    expect(
      sslOptionForUrl(
        'postgres://db.example/monitor?sslmode=verify-full',
        {},
      ),
    ).toBeUndefined();
    expect(
      sslOptionForUrl('postgres://db.example/monitor', {
        PGSSLMODE: 'disable',
      }),
    ).toBe(false);
  });
});
