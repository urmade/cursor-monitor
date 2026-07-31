import { describe, expect, it } from 'vitest';
import {
  agentMatchesRepoFilter,
  agentRepoLabels,
  aggregateUsageCost,
  classifyRunStatus,
  extractPrLinksFromGit,
  formatCentsUsd,
  formatDurationMs,
  formatPrLabel,
  formatRelativeTime,
  groupAgentsByRepo,
  groupConversationsByPr,
  NO_PR_GROUP,
  NO_REPO_GROUP,
  parseConversationGroupSort,
  preferredChargedCents,
  runDidNotFinish,
  runWallClockMs,
  sortConversationGroups,
  sortProjectSummaries,
  summarizeProject,
  type EnrichedAgent,
} from '../server/cursor';

describe('monitoring format helpers', () => {
  it('formats duration', () => {
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(420)).toBe('420 ms');
    expect(formatDurationMs(12_000)).toBe('12s');
    expect(formatDurationMs(90_110)).toBe('1m 30s');
    expect(formatDurationMs(36_707_740)).toBe('10h 11m');
  });

  it('measures run duration as wall-clock time', () => {
    const finished = runWallClockMs({
      status: 'FINISHED',
      createdAt: '2026-07-27T18:05:09.467Z',
      updatedAt: '2026-07-28T04:16:57.207Z',
    });
    expect(finished).toBeGreaterThan(10 * 3600_000);
    expect(formatDurationMs(finished)).toMatch(/^10h/);

    const now = Date.parse('2026-07-30T12:00:00.000Z');
    const running = runWallClockMs(
      { status: 'RUNNING', createdAt: '2026-07-30T11:30:00.000Z' },
      now,
    );
    expect(running).toBe(30 * 60_000);

    expect(runWallClockMs({ status: 'FINISHED' })).toBeNull();
    expect(
      runWallClockMs({
        status: 'FINISHED',
        createdAt: 'not-a-date',
        updatedAt: 'also-not-a-date',
      }),
    ).toBeNull();
  });

  it('classifies run outcomes and flags runs that did not finish', () => {
    expect(classifyRunStatus('FINISHED')).toBe('finished');
    expect(classifyRunStatus('ERROR')).toBe('failed');
    expect(classifyRunStatus('CANCELLED')).toBe('cancelled');
    expect(classifyRunStatus('EXPIRED')).toBe('expired');
    expect(classifyRunStatus('RUNNING')).toBe('running');
    expect(classifyRunStatus('ACTIVE')).toBe('running');
    expect(classifyRunStatus(undefined)).toBe('unknown');
    expect(classifyRunStatus('SOME_NEW_STATUS')).toBe('unknown');

    expect(runDidNotFinish('ERROR')).toBe(true);
    expect(runDidNotFinish('CANCELLED')).toBe(true);
    expect(runDidNotFinish('EXPIRED')).toBe(true);
    expect(runDidNotFinish('FINISHED')).toBe(false);
    expect(runDidNotFinish('RUNNING')).toBe(false);
  });

  it('formats cents as USD', () => {
    expect(formatCentsUsd(undefined)).toBe('—');
    expect(formatCentsUsd(57.36916)).toBe('$0.5737');
    expect(formatCentsUsd(100)).toBe('$1.00');
    expect(formatCentsUsd(432.41)).toBe('$4.32');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    expect(formatRelativeTime(null, now)).toBe('—');
    expect(formatRelativeTime('2026-07-30T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-30T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelativeTime('2026-07-30T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-28T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('labels and filters repos', () => {
    expect(
      agentRepoLabels([{ url: 'https://github.com/internalsphere/nexus' }]),
    ).toEqual(['internalsphere/nexus']);
    expect(
      agentMatchesRepoFilter(
        {
          name: 'Cloud agent runs costs',
          repos: [{ url: 'https://github.com/internalsphere/nexus' }],
        },
        'nexus',
      ),
    ).toBe(true);
    expect(
      agentMatchesRepoFilter(
        { name: 'Other', repos: [{ url: 'https://github.com/acme/AnyExpenses' }] },
        'anyexpenses',
      ),
    ).toBe(true);
    expect(
      agentMatchesRepoFilter({ name: 'Slackmark', repos: [] }, 'nexus'),
    ).toBe(false);
  });

  it('groups agents by repository', () => {
    const groups = groupAgentsByRepo([
      {
        id: 'a',
        name: 'Nexus run',
        createdAt: '2026-07-30T12:00:00.000Z',
        repos: [{ url: 'https://github.com/internalsphere/nexus' }],
      },
      {
        id: 'b',
        name: 'Older nexus',
        createdAt: '2026-07-29T12:00:00.000Z',
        repos: [{ url: 'https://github.com/internalsphere/nexus' }],
      },
      {
        id: 'c',
        name: 'Expenses',
        createdAt: '2026-07-28T12:00:00.000Z',
        repos: [{ url: 'https://github.com/acme/AnyExpenses' }],
      },
      {
        id: 'd',
        name: 'No repo',
        createdAt: '2026-07-27T12:00:00.000Z',
        repos: [],
      },
      {
        id: 'e',
        name: 'Multi',
        createdAt: '2026-07-26T12:00:00.000Z',
        repos: [
          { url: 'https://github.com/internalsphere/nexus' },
          { url: 'https://github.com/acme/AnyExpenses' },
        ],
      },
    ]);

    expect(groups.map((g) => g.repo)).toEqual([
      'acme/AnyExpenses',
      'internalsphere/nexus',
      NO_REPO_GROUP,
    ]);
    expect(groups[0]!.agents.map((a) => a.id)).toEqual(['c', 'e']);
    expect(groups[1]!.agents.map((a) => a.id)).toEqual(['a', 'b', 'e']);
    expect(groups[2]!.agents.map((a) => a.id)).toEqual(['d']);
  });

  it('extracts PR links from git.branches', () => {
    expect(formatPrLabel('https://github.com/internalsphere/nexus/pull/28')).toBe(
      'internalsphere/nexus#28',
    );
    const prs = extractPrLinksFromGit({
      branches: [
        {
          repoUrl: 'github.com/internalsphere/nexus',
          branch: 'cursor/monitoring-rework-f0d4',
          prUrl: 'https://github.com/internalsphere/nexus/pull/28',
        },
        {
          repoUrl: 'github.com/internalsphere/nexus',
          branch: 'cursor/monitoring-rework-f0d4',
          prUrl: 'https://github.com/internalsphere/nexus/pull/28',
        },
        { repoUrl: 'github.com/acme/x', branch: 'feat' },
      ],
    });
    expect(prs).toEqual([
      {
        prUrl: 'https://github.com/internalsphere/nexus/pull/28',
        label: 'internalsphere/nexus#28',
        branch: 'cursor/monitoring-rework-f0d4',
        repoUrl: 'github.com/internalsphere/nexus',
      },
    ]);
  });

  it('aggregates cost as sum of run costs', () => {
    const agg = aggregateUsageCost(
      {
        chargedCents: 1.0,
        rawCostCents: 1.5,
        runs: [
          { id: 'r1', cost: { chargedCents: 0.4, rawCostCents: 0.6 } },
          { id: 'r2', cost: { chargedCents: 0.6, rawCostCents: 0.9 } },
        ],
      },
      2,
    );
    expect(agg.chargedSumCents).toBeCloseTo(1.0);
    expect(agg.rawSumCents).toBeCloseTo(1.5);
    expect(agg.providerChargedCents).toBe(1.0);
    expect(agg.runCountWithCost).toBe(2);
    expect(agg.runCount).toBe(2);
  });
});

function conversation(
  id: string,
  prUrls: string[],
  chargedCents: number | null,
  createdAt: string,
): EnrichedAgent {
  return {
    id,
    name: id,
    createdAt,
    prs: prUrls.map((prUrl) => ({ prUrl, label: prUrl })),
    cost: {
      chargedSumCents: chargedCents,
      rawSumCents: chargedCents != null ? chargedCents * 1.4 : null,
      providerChargedCents: null,
      providerRawCents: null,
      runCountWithCost: chargedCents != null ? 1 : 0,
      runCount: 1,
    },
  };
}

const PR_A = 'https://github.com/internalsphere/nexus/pull/28';
const PR_B = 'https://github.com/internalsphere/nexus/pull/31';

describe('conversation grouping by pull request', () => {
  const agents = [
    conversation('c1', [PR_A], 100, '2026-07-28T10:00:00.000Z'),
    conversation('c2', [PR_A], 250, '2026-07-30T10:00:00.000Z'),
    conversation('c3', [PR_B], 500, '2026-07-29T10:00:00.000Z'),
    conversation('c4', [], null, '2026-07-27T10:00:00.000Z'),
  ];

  it('groups conversations targeting the same PR with cost totals', () => {
    const groups = groupConversationsByPr(agents);
    expect(groups.map((g) => g.key).sort()).toEqual([PR_A, PR_B, NO_PR_GROUP].sort());

    const a = groups.find((g) => g.key === PR_A)!;
    expect(a.conversations.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(a.totalChargedCents).toBe(350);
    expect(a.totalRawCents).toBeCloseTo(490);
    expect(a.latestCreatedAt).toBe('2026-07-30T10:00:00.000Z');

    const none = groups.find((g) => g.key === NO_PR_GROUP)!;
    expect(none.pr).toBeNull();
    expect(none.conversations.map((c) => c.id)).toEqual(['c4']);
    expect(none.totalChargedCents).toBeNull();
  });

  it('sorts groups by total cost or by created at, no-PR bucket last', () => {
    const groups = groupConversationsByPr(agents);

    const byCost = sortConversationGroups(groups, 'cost');
    expect(byCost.map((g) => g.key)).toEqual([PR_B, PR_A, NO_PR_GROUP]);

    const byCreated = sortConversationGroups(groups, 'created');
    expect(byCreated.map((g) => g.key)).toEqual([PR_A, PR_B, NO_PR_GROUP]);
  });

  it('parses the sort search param', () => {
    expect(parseConversationGroupSort('created')).toBe('created');
    expect(parseConversationGroupSort('cost')).toBe('cost');
    expect(parseConversationGroupSort(undefined)).toBe('cost');
    expect(parseConversationGroupSort('bogus')).toBe('cost');
  });
});

describe('project summaries', () => {
  it('summarizes a repo group into a project', () => {
    const summary = summarizeProject({
      repo: 'internalsphere/nexus',
      agents: [
        conversation('c1', [PR_A], 100, '2026-07-28T10:00:00.000Z'),
        conversation('c2', [PR_A, PR_B], 250, '2026-07-30T10:00:00.000Z'),
      ],
    });
    expect(summary.conversationCount).toBe(2);
    expect(summary.prCount).toBe(2);
    expect(summary.totalChargedCents).toBe(350);
    expect(summary.latestCreatedAt).toBe('2026-07-30T10:00:00.000Z');
  });

  it('orders projects by latest activity, no-repo last', () => {
    const ordered = sortProjectSummaries([
      {
        repo: NO_REPO_GROUP,
        conversationCount: 1,
        prCount: 0,
        totalChargedCents: null,
        totalRawCents: null,
        latestCreatedAt: '2026-07-30T10:00:00.000Z',
      },
      {
        repo: 'acme/old',
        conversationCount: 1,
        prCount: 0,
        totalChargedCents: null,
        totalRawCents: null,
        latestCreatedAt: '2026-07-20T10:00:00.000Z',
      },
      {
        repo: 'internalsphere/nexus',
        conversationCount: 2,
        prCount: 1,
        totalChargedCents: 350,
        totalRawCents: 490,
        latestCreatedAt: '2026-07-29T10:00:00.000Z',
      },
    ]);
    expect(ordered.map((p) => p.repo)).toEqual([
      'internalsphere/nexus',
      'acme/old',
      NO_REPO_GROUP,
    ]);
  });

  it('prefers summed run cost, falling back to provider totals', () => {
    expect(
      preferredChargedCents(
        conversation('c1', [], 100, '2026-07-28T10:00:00.000Z'),
      ),
    ).toBe(100);
    const providerOnly = conversation('c2', [], null, '2026-07-28T10:00:00.000Z');
    providerOnly.cost.providerChargedCents = 42;
    expect(preferredChargedCents(providerOnly)).toBe(42);
  });
});
