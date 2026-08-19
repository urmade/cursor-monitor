import { afterEach, describe, expect, it } from 'vitest';
import { authorizeHookRequest, parseHookEvent } from './hook-ingest';
import { buildInstaller } from './installers';

const previous = {
  token: process.env.CURSOR_MONITOR_HOOK_TOKEN,
  bypass: process.env.VERCEL_PROTECTION_BYPASS,
  publicUrl: process.env.CURSOR_MONITOR_PUBLIC_URL,
  deployment: process.env.DEPLOYMENT_URL,
  databaseAdapter: process.env.DATABASE_ADAPTER,
  database: process.env.DATABASE_URL,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('CURSOR_MONITOR_HOOK_TOKEN', previous.token);
  restore('VERCEL_PROTECTION_BYPASS', previous.bypass);
  restore('CURSOR_MONITOR_PUBLIC_URL', previous.publicUrl);
  restore('DEPLOYMENT_URL', previous.deployment);
  restore('DATABASE_ADAPTER', previous.databaseAdapter);
  restore('DATABASE_URL', previous.database);
});

describe('hook ingestion', () => {
  it('requires a timing-safe application token', () => {
    process.env.CURSOR_MONITOR_HOOK_TOKEN = 'monitor-test-token';
    expect(
      authorizeHookRequest(
        new Request('https://monitor.test/api/hooks/events', {
          headers: { 'x-cursor-monitor-token': 'monitor-test-token' },
        }),
      ),
    ).toBe(true);
    expect(
      authorizeHookRequest(
        new Request('https://monitor.test/api/hooks/events', {
          headers: { 'x-cursor-monitor-token': 'wrong-token' },
        }),
      ),
    ).toBe(false);
  });

  it('normalizes repositories and derives duration', () => {
    const event = parseHookEvent(
      {
        conversation_id: ' ABC ',
        generation_id: 'generation-1',
        repo: 'git@github.com:Acme/App.git',
        started_at: '2026-08-17T12:00:00.000Z',
        finished_at: '2026-08-17T12:00:04.500Z',
      },
      new Date('2026-08-17T12:00:05.000Z'),
    );
    expect(event).toMatchObject({
      conversationId: 'ABC',
      conversationKey: 'abc',
      repositoryKey: 'acme/app',
      repositoryLabel: 'Acme/App',
      durationMs: 4500,
    });
  });
});

describe('platform installers', () => {
  it.each(['linux', 'macos', 'windows'] as const)(
    'generates a dependency-light %s installer',
    (platform) => {
      process.env.CURSOR_MONITOR_HOOK_TOKEN = 'monitor-test-token';
      process.env.VERCEL_PROTECTION_BYPASS = 'bypass-test-token';
      process.env.DEPLOYMENT_URL = 'https://monitor.example';
      const installer = buildInstaller(platform);
      expect(installer?.ready).toBe(true);
      expect(installer?.content).toContain(
        'https://monitor.example/api/hooks/events',
      );
      expect(installer?.content).toContain('monitor-test-token');
      expect(installer?.content).toContain('hooks.cursor-monitor.example.json');
      expect(installer?.content).not.toMatch(/\b(jq|python|node|npm|brew)\b/i);
      if (platform === 'windows') {
        expect(installer?.content).toContain('Invoke-WebRequest');
        expect(installer?.content).toContain('UTF8Encoding($false)');
        expect(installer?.content).toContain('cursor-monitor-stop.ps1');
      } else {
        expect(installer?.content).toContain('#!/bin/sh');
        expect(installer?.content).toContain('cursor-monitor-stop.sh');
      }
    },
  );

  it('does not reuse the deployment bypass as the app token', () => {
    delete process.env.CURSOR_MONITOR_HOOK_TOKEN;
    process.env.VERCEL_PROTECTION_BYPASS = 'bypass-only';
    expect(buildInstaller('linux')?.ready).toBe(false);
  });

  it('regenerates the current app endpoint without exposing database details', () => {
    process.env.CURSOR_MONITOR_HOOK_TOKEN = 'monitor-test-token';
    process.env.DATABASE_ADAPTER = 'private-backend';
    process.env.DATABASE_URL =
      'postgres://database-user:database-password@database.internal/monitor';
    process.env.CURSOR_MONITOR_PUBLIC_URL = 'https://monitor-one.example';
    const first = buildInstaller('linux')?.content;

    process.env.CURSOR_MONITOR_PUBLIC_URL = 'https://monitor-two.example';
    const second = buildInstaller('linux')?.content;

    expect(first).toContain('https://monitor-one.example/api/hooks/events');
    expect(second).toContain('https://monitor-two.example/api/hooks/events');
    expect(second).not.toContain('monitor-one.example');
    expect(second).not.toContain('database.internal');
    expect(second).not.toContain('database-password');
    expect(second).not.toContain('private-backend');
  });
});
