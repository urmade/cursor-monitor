import { afterEach, describe, expect, it } from 'vitest';
import { authorizeHookRequest, parseHookEvent } from './hook-ingest';
import { buildInstaller } from './installers';

const previous = {
  token: process.env.CURSOR_MONITOR_HOOK_TOKEN,
  bypass: process.env.VERCEL_PROTECTION_BYPASS,
  deployment: process.env.DEPLOYMENT_URL,
};

afterEach(() => {
  process.env.CURSOR_MONITOR_HOOK_TOKEN = previous.token;
  process.env.VERCEL_PROTECTION_BYPASS = previous.bypass;
  process.env.DEPLOYMENT_URL = previous.deployment;
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
});
