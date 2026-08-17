import { describe, expect, it } from 'vitest';
import { buildMonitorTree, type MonitorHookRecord } from './aggregation';
import {
  canonicalRepository,
  normalizeRepositoryLabel,
  NO_REPOSITORY_KEY,
} from './identity';
import {
  preferenceMap,
  resolveMergeRoot,
  validateRepositoryMerge,
} from './preferences';

function hook(overrides: Partial<MonitorHookRecord>): MonitorHookRecord {
  return {
    id: crypto.randomUUID(),
    eventName: 'stop',
    conversationId: 'conversation-1',
    conversationKey: 'conversation-1',
    generationId: null,
    repositoryKey: 'acme/app',
    repositoryLabel: 'Acme/App',
    gitBranch: 'main',
    workspaceRoot: null,
    userEmail: 'person@example.com',
    model: 'composer',
    status: 'completed',
    durationMs: 1000,
    payload: {},
    occurredAt: '2026-08-17T12:00:00.000Z',
    receivedAt: '2026-08-17T12:00:01.000Z',
    ...overrides,
  };
}

describe('repository identity', () => {
  it('collapses case variants and normalizes remotes', () => {
    expect(canonicalRepository(' Acme/APP ')).toBe('acme/app');
    expect(canonicalRepository('')).toBe(NO_REPOSITORY_KEY);
    expect(normalizeRepositoryLabel('git@github.com:Acme/App.git')).toBe(
      'Acme/App',
    );
    expect(normalizeRepositoryLabel('https://github.com/Acme/App')).toBe(
      'Acme/App',
    );
  });

  it('resolves transitive merges and rejects cycles', () => {
    const preferences = preferenceMap([
      {
        repositoryKey: 'acme/worker',
        displayName: null,
        mergedIntoKey: 'acme/api',
      },
      {
        repositoryKey: 'acme/api',
        displayName: 'Platform',
        mergedIntoKey: 'acme/app',
      },
    ]);
    expect(resolveMergeRoot('ACME/Worker', preferences)).toBe('acme/app');
    expect(() =>
      validateRepositoryMerge('acme/app', 'acme/worker', preferences),
    ).toThrow(/cycle/i);
  });
});

describe('monitor tree', () => {
  it('merges case-only repos and applies repository and conversation names', () => {
    const tree = buildMonitorTree({
      hooks: [
        hook({ id: '1', repositoryKey: 'Acme/App' }),
        hook({
          id: '2',
          conversationId: 'conversation-2',
          conversationKey: 'CONVERSATION-2',
          repositoryKey: 'acme/app',
          occurredAt: '2026-08-17T13:00:00.000Z',
        }),
      ],
      usage: [
        {
          fingerprint: 'usage-1',
          conversationId: 'CONVERSATION-1',
          conversationKey: 'conversation-1',
          userEmail: null,
          model: 'composer',
          kind: 'agent',
          chargedCents: 12.5,
          occurredAt: '2026-08-17T12:00:00.000Z',
        },
      ],
      repositoryPreferences: [
        {
          repositoryKey: 'acme/app',
          displayName: 'Main application',
          mergedIntoKey: null,
        },
      ],
      conversationNames: new Map([['conversation-1', 'Release audit']]),
    });

    expect(tree.projects).toHaveLength(1);
    expect(tree.projects[0]).toMatchObject({
      key: 'acme/app',
      displayName: 'Main application',
      conversationCount: 2,
      chargedCents: 12.5,
    });
    expect(
      tree.projects[0]?.conversations.find(
        (conversation) => conversation.key === 'conversation-1',
      ),
    ).toMatchObject({
      displayName: 'Release audit',
      chargedCents: 12.5,
      usageEventCount: 1,
    });
  });

  it('assigns usage once to the latest repository for a moved conversation', () => {
    const tree = buildMonitorTree({
      hooks: [
        hook({
          id: 'new',
          repositoryKey: 'acme/new',
          occurredAt: '2026-08-17T14:00:00.000Z',
        }),
        hook({
          id: 'old',
          repositoryKey: 'acme/old',
          occurredAt: '2026-08-17T12:00:00.000Z',
        }),
      ],
      usage: [
        {
          fingerprint: 'usage',
          conversationId: 'conversation-1',
          conversationKey: 'conversation-1',
          userEmail: null,
          model: null,
          kind: null,
          chargedCents: 5,
          occurredAt: '2026-08-17T13:00:00.000Z',
        },
      ],
    });
    expect(tree.projects).toHaveLength(1);
    expect(tree.projects[0]).toMatchObject({
      key: 'acme/new',
      chargedCents: 5,
      eventCount: 2,
    });
  });

  it('keeps events without conversation ids separate by generation and repository', () => {
    const tree = buildMonitorTree({
      hooks: [
        hook({
          id: 'one',
          conversationId: null,
          conversationKey: null,
          generationId: 'generation-one',
          repositoryKey: 'acme/one',
        }),
        hook({
          id: 'two',
          conversationId: null,
          conversationKey: null,
          generationId: 'generation-two',
          repositoryKey: 'acme/two',
        }),
      ],
      usage: [],
    });
    expect(tree.projects.map((project) => project.key).sort()).toEqual([
      'acme/one',
      'acme/two',
    ]);
    expect(tree.projects.flatMap((project) => project.conversations)).toHaveLength(
      2,
    );
  });
});
