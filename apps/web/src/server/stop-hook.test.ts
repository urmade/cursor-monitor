import { afterEach, describe, expect, it } from 'vitest';
import { buildHookSignalsTree, type HookSignalEvent } from './hook-signals';
import {
  authorizeStopHookRequest,
  buildStopHookArtifact,
  extractBranchFromPayload,
  extractRepoFromPayload,
  normalizeRepoLabel,
  readProtectionBypass,
  resolvePublicBaseUrl,
} from './stop-hook';

describe('stop-hook helpers', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it('prefers NEXUS_VERCEL_BYPASS over VERCEL_PROTECTION_BYPASS', () => {
    process.env.NEXUS_VERCEL_BYPASS = 'cloud-bypass-token-value!!';
    process.env.VERCEL_PROTECTION_BYPASS = 'vercel-bypass-token-value';
    expect(readProtectionBypass()).toBe('cloud-bypass-token-value!!');
  });

  it('falls back to VERCEL_PROTECTION_BYPASS', () => {
    delete process.env.NEXUS_VERCEL_BYPASS;
    process.env.VERCEL_PROTECTION_BYPASS = 'vercel-only-token-value!!';
    expect(readProtectionBypass()).toBe('vercel-only-token-value!!');
  });

  it('authorizes matching bypass header', () => {
    process.env.NEXUS_VERCEL_BYPASS = 'exact-match-bypass-secret';
    const req = new Request('http://localhost/api/hooks/stop', {
      headers: { 'x-vercel-protection-bypass': 'exact-match-bypass-secret' },
    });
    expect(authorizeStopHookRequest(req)).toBe(true);
  });

  it('rejects missing or mismatched bypass', () => {
    process.env.NEXUS_VERCEL_BYPASS = 'exact-match-bypass-secret';
    expect(
      authorizeStopHookRequest(new Request('http://localhost/api/hooks/stop')),
    ).toBe(false);
    expect(
      authorizeStopHookRequest(
        new Request('http://localhost/api/hooks/stop', {
          headers: { 'x-vercel-protection-bypass': 'wrong' },
        }),
      ),
    ).toBe(false);
  });

  it('resolves public base URL from DEPLOYMENT_URL', () => {
    process.env.DEPLOYMENT_URL = 'https://nexus.example/';
    expect(resolvePublicBaseUrl()).toBe('https://nexus.example');
  });

  it('embeds endpoint and bypass into a native shell script', () => {
    const artifact = buildStopHookArtifact({
      baseUrl: 'https://nexus.example',
      bypass: 'hardcoded-bypass-token',
    });
    expect(artifact.endpoint).toBe('https://nexus.example/api/hooks/stop');
    expect(artifact.bypassConfigured).toBe(true);
    expect(artifact.scriptFilename).toBe('nexus-stop-to-supabase.sh');
    expect(artifact.script.startsWith('#!/bin/bash')).toBe(true);
    expect(artifact.script).toContain('hardcoded-bypass-token');
    expect(artifact.script).toContain('https://nexus.example/api/hooks/stop');
    expect(artifact.script).toContain('x-vercel-protection-bypass');
    expect(artifact.script).toContain('curl ');
    expect(artifact.script).toContain('detect_git');
    expect(artifact.script).not.toMatch(/python3|urllib|#!\/usr\/bin\/env python/i);
    expect(JSON.parse(artifact.hooksJson)).toMatchObject({
      version: 1,
      hooks: {
        stop: [{ command: `.cursor/hooks/${artifact.scriptFilename}` }],
      },
    });
  });

  it('normalizes git remotes into owner/repo', () => {
    expect(normalizeRepoLabel('nina.v@example.com:acme/widgets.git')).toBe(
      'acme/widgets',
    );
    expect(normalizeRepoLabel('https://github.com/acme/widgets.git')).toBe(
      'acme/widgets',
    );
    expect(extractRepoFromPayload({ repository: 'acme/widgets' })).toBe(
      'acme/widgets',
    );
    expect(extractBranchFromPayload({ git_branch: 'feat/x' })).toBe('feat/x');
  });
});

describe('hook signals tree', () => {
  it('groups events by user → repo → conversation', () => {
    const events: HookSignalEvent[] = [
      {
        id: '1',
        userEmail: 'a@example.com',
        repo: 'acme/one',
        gitBranch: 'main',
        workspaceRoot: '/tmp/one',
        conversationId: 'c1',
        generationId: 'g1',
        model: 'm',
        modelId: null,
        hookEventName: 'stop',
        status: 'completed',
        loopCount: 0,
        cursorVersion: '3',
        transcriptPath: null,
        workspaceRoots: ['/tmp/one'],
        modelParams: null,
        chargedCents: 1.5,
        costSource: 'organizations.filtered-usage-events',
        costLookupError: null,
        usageEvent: { chargedCents: 1.5 },
        payload: { status: 'completed' },
        receivedAt: '2026-07-31T12:00:00.000Z',
      },
      {
        id: '2',
        userEmail: 'a@example.com',
        repo: 'acme/one',
        gitBranch: 'main',
        workspaceRoot: '/tmp/one',
        conversationId: 'c1',
        generationId: 'g2',
        model: 'm',
        modelId: null,
        hookEventName: 'stop',
        status: 'error',
        loopCount: 1,
        cursorVersion: '3',
        transcriptPath: null,
        workspaceRoots: ['/tmp/one'],
        modelParams: null,
        chargedCents: null,
        costSource: null,
        costLookupError: 'no match',
        usageEvent: null,
        payload: { status: 'error' },
        receivedAt: '2026-07-31T11:00:00.000Z',
      },
      {
        id: '3',
        userEmail: 'b@example.com',
        repo: null,
        gitBranch: null,
        workspaceRoot: null,
        conversationId: null,
        generationId: null,
        model: null,
        modelId: null,
        hookEventName: 'stop',
        status: 'aborted',
        loopCount: 0,
        cursorVersion: null,
        transcriptPath: null,
        workspaceRoots: [],
        modelParams: null,
        chargedCents: null,
        costSource: null,
        costLookupError: null,
        usageEvent: null,
        payload: {},
        receivedAt: '2026-07-31T10:00:00.000Z',
      },
    ];

    const tree = buildHookSignalsTree(events);
    expect(tree.totalEvents).toBe(3);
    expect(tree.users.map((u) => u.userEmail)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(tree.users[0]!.repos[0]!.repo).toBe('acme/one');
    expect(tree.users[0]!.repos[0]!.branches).toEqual(['main']);
    expect(tree.users[0]!.repos[0]!.conversations[0]!.events).toHaveLength(2);
    expect(tree.users[0]!.repos[0]!.conversations[0]!.chargedCentsTotal).toBe(
      1.5,
    );
    expect(tree.users[1]!.repos[0]!.repo).toBe('Unknown repo');
    expect(tree.users[1]!.repos[0]!.conversations[0]!.conversationId).toBe(
      'Unknown conversation',
    );
  });
});
