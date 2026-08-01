import { describe, expect, it, beforeEach } from 'vitest';
import {
  getCachedAgentCatalog,
  getCachedEnrichedAgents,
  resetMonitoringMemoryCache,
} from '../server/monitoring-cache';
import type { AgentSummary, CursorClient } from '@nexus/cursor-client';
import { classifyRunStatus } from '../lib/monitoring-status';
import { sortConversationGroupsBy } from '../lib/monitoring-format';

function agent(partial: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    name: partial.name ?? partial.id,
    status: partial.status ?? 'ACTIVE',
    createdAt: partial.createdAt ?? '2026-07-30T00:00:00.000Z',
    repos: partial.repos ?? [{ url: 'https://github.com/internalsphere/nexus' }],
    ...partial,
  };
}

function mockClient(opts: {
  agents?: AgentSummary[];
  usageCents?: number;
  runStatus?: string;
  listCalls?: { agents: number; usage: number; runs: number };
}): CursorClient {
  const counts = opts.listCalls ?? { agents: 0, usage: 0, runs: 0 };
  const agents = opts.agents ?? [agent({ id: 'bc-1' }), agent({ id: 'bc-2' })];
  return {
    listAllAgents: async () => {
      counts.agents += 1;
      return { items: agents, truncated: false };
    },
    getUsage: async () => {
      counts.usage += 1;
      return {
        chargedCents: opts.usageCents ?? 100,
        rawCostCents: 120,
        runs: [
          {
            id: 'run-1',
            cost: {
              chargedCents: opts.usageCents ?? 100,
              rawCostCents: 120,
            },
          },
        ],
      };
    },
    listRuns: async () => {
      counts.runs += 1;
      return {
        items: [
          {
            id: 'run-1',
            status: opts.runStatus ?? 'FINISHED',
            createdAt: '2026-07-30T00:00:00.000Z',
            git: {
              branches: [
                {
                  prUrl: 'https://github.com/internalsphere/nexus/pull/28',
                  branch: 'cursor/monitoring-perf-83be',
                },
              ],
            },
          },
        ],
        nextCursor: null,
      };
    },
  } as unknown as CursorClient;
}

describe('monitoring cache', () => {
  beforeEach(() => {
    resetMonitoringMemoryCache();
  });

  it('serves the agent catalogue from memory on repeat visits', async () => {
    const counts = { agents: 0, usage: 0, runs: 0 };
    const client = mockClient({ listCalls: counts });

    const first = await getCachedAgentCatalog(client, 'fp-test');
    const second = await getCachedAgentCatalog(client, 'fp-test');

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(counts.agents).toBe(1);
  });

  it('skips Cursor fan-out for cached enrichment', async () => {
    const counts = { agents: 0, usage: 0, runs: 0 };
    const client = mockClient({
      listCalls: counts,
      runStatus: 'FINISHED',
      usageCents: 42,
    });
    const agents = [agent({ id: 'bc-1' })];

    const first = await getCachedEnrichedAgents(client, 'fp-test', agents, {
      limit: 10,
    });
    const second = await getCachedEnrichedAgents(client, 'fp-test', agents, {
      limit: 10,
    });

    expect(first.agents[0]?.latestRunStatus).toBe('FINISHED');
    expect(first.agents[0]?.cost.chargedSumCents).toBe(42);
    // Branch comes from the newest run's git.branches snapshot.
    expect(first.agents[0]?.branch).toBe('cursor/monitoring-perf-83be');
    expect(second.agents[0]?.cost.chargedSumCents).toBe(42);
    expect(counts.usage).toBe(1);
    expect(counts.runs).toBe(1);
  });
});

describe('status + sort client helpers', () => {
  it('does not treat ACTIVE as running', () => {
    expect(classifyRunStatus('ACTIVE')).toBe('unknown');
    expect(classifyRunStatus('RUNNING')).toBe('running');
    expect(classifyRunStatus('FINISHED')).toBe('finished');
  });

  it('sorts conversation groups in-memory', () => {
    const groups = [
      { key: 'https://pr/1', totalChargedCents: 10, latestCreatedAt: '2026-07-01T00:00:00.000Z' },
      { key: 'https://pr/2', totalChargedCents: 50, latestCreatedAt: '2026-07-02T00:00:00.000Z' },
      { key: 'no-pull-request', totalChargedCents: 999, latestCreatedAt: '2026-07-03T00:00:00.000Z' },
    ];
    const byCost = sortConversationGroupsBy(groups, 'cost');
    expect(byCost.map((g) => g.key)).toEqual([
      'https://pr/2',
      'https://pr/1',
      'no-pull-request',
    ]);
    const byCreated = sortConversationGroupsBy(groups, 'created');
    expect(byCreated.map((g) => g.key)).toEqual([
      'https://pr/2',
      'https://pr/1',
      'no-pull-request',
    ]);
  });
});
