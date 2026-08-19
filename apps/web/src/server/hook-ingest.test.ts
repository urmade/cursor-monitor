import { afterEach, describe, expect, it } from 'vitest';
import { authorizeHookRequest, parseHookEvent } from './hook-ingest';
import { buildHookScripts, getHookScript, hookScriptDownloadHeaders, resolveHookScriptDownload } from './hook-scripts';

const previous = {
  token: process.env.CURSOR_MONITOR_HOOK_TOKEN,
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

describe('Team Hook scripts', () => {
  it.each(['linux', 'macos', 'windows'] as const)(
    'generates direct dependency-light %s scripts',
    (platform) => {
      process.env.CURSOR_MONITOR_HOOK_TOKEN = 'monitor-test-token';
      process.env.DEPLOYMENT_URL = 'https://monitor.example';
      const bundle = buildHookScripts(platform);
      expect(bundle?.ready).toBe(true);
      expect(bundle?.scripts.map((script) => script.eventName)).toEqual([
        'beforeSubmitPrompt',
        'stop',
      ]);
      const start = getHookScript(platform, 'start');
      const stop = getHookScript(platform, 'stop');
      expect(start?.content).toContain('Team Hook: beforeSubmitPrompt');
      expect(stop?.content).toContain(
        'https://monitor.example/api/hooks/events',
      );
      expect(stop?.content).toContain('monitor-test-token');
      expect(stop?.content).not.toMatch(/\b(jq|python|node|npm|brew)\b/i);
      expect(stop?.content).not.toContain('hooks.json');
      expect(stop?.content).not.toContain('project-hook installer');
      if (platform === 'windows') {
        expect(start?.filename).toBe('cursor-monitor-windows-start.ps1');
        expect(stop?.filename).toBe('cursor-monitor-windows-stop.ps1');
        expect(stop?.content).toContain('Invoke-WebRequest');
      } else {
        expect(start?.filename).toBe(`cursor-monitor-${platform}-start.sh`);
        expect(stop?.filename).toBe(`cursor-monitor-${platform}-stop.sh`);
        expect(start?.content).toContain('#!/bin/sh');
        expect(stop?.content).toContain('#!/bin/sh');
      }
    },
  );

  it('requires a dedicated hook token before scripts are ready', () => {
    delete process.env.CURSOR_MONITOR_HOOK_TOKEN;
    expect(buildHookScripts('linux')?.ready).toBe(false);
  });

  it('regenerates direct scripts without exposing database details', () => {
    process.env.CURSOR_MONITOR_HOOK_TOKEN = 'monitor-test-token';
    process.env.DATABASE_ADAPTER = 'private-backend';
    process.env.DATABASE_URL =
      'postgres://database-user:database-password@database.internal/monitor';
    process.env.CURSOR_MONITOR_PUBLIC_URL = 'https://monitor-one.example';
    const first = getHookScript('linux', 'stop')?.content;

    process.env.CURSOR_MONITOR_PUBLIC_URL = 'https://monitor-two.example';
    const second = getHookScript('linux', 'stop')?.content;

    expect(first).toContain('https://monitor-one.example/api/hooks/events');
    expect(second).toContain('https://monitor-two.example/api/hooks/events');
    expect(second).not.toContain('monitor-one.example');
    expect(second).not.toContain('database.internal');
    expect(second).not.toContain('database-password');
    expect(second).not.toContain('private-backend');
  });

  it('rejects unsupported script requests', () => {
    expect(getHookScript('linux', 'unknown')).toBeNull();
    expect(getHookScript('unknown', 'stop')).toBeNull();
    expect(resolveHookScriptDownload('linux', 'unknown')).toEqual({
      status: 'unsupported',
    });
  });

  it('blocks download resolution until the hook token is configured', () => {
    delete process.env.CURSOR_MONITOR_HOOK_TOKEN;
    expect(resolveHookScriptDownload('linux', 'stop')).toMatchObject({
      status: 'not_ready',
    });
    process.env.CURSOR_MONITOR_HOOK_TOKEN = 'monitor-test-token';
    const resolved = resolveHookScriptDownload('linux', 'stop');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(hookScriptDownloadHeaders(resolved.artifact)).toMatchObject({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'attachment; filename="cursor-monitor-linux-stop.sh"',
    });
  });
});
