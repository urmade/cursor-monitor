import { describe, expect, it } from 'vitest';
import {
  agentMatchesRepoFilter,
  agentRepoLabels,
  agentRepoLabelsIncludingPrs,
  aggregateUsageCost,
  attachGithubPrTitles,
  classifyRunStatus,
  extractPrLinksFromGit,
  formatCentsUsd,
  formatDurationMs,
  formatPrLabel,
  formatPrNumberLabel,
  formatRelativeTime,
  groupAgentsByRepo,
  groupConversationsByPr,
  groupEnrichedAgentsByRepo,
  NO_PR_GROUP,
  NO_REPO_GROUP,
  parseConversationGroupSort,
  parseGithubPrRef,
  partitionProjectRuns,
  preferredChargedCents,
  resolvePrDisplayName,
  runDidNotFinish,
  runWallClockMs,
  sortConversationGroups,
  sortProjectSummaries,
  summarizeProject,
  type EnrichedAgent,
} from '../server/cursor';
import {
  automationDisplayName,
  automationMetaFromRun,
  partitionProjectRunsByAutomation,
} from '../lib/monitoring-format';
import {
  applyAutomationAttribution,
  loadAutomationAttributionMap,
} from '../server/automation-attribution';
import type { CursorAdminClient } from '@nexus/cursor-client';


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
    // v1 agent-level ACTIVE is not a run-in-progress signal
    expect(classifyRunStatus('ACTIVE')).toBe('unknown');
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
      agentRepoLabels([{ url: 'https://github.com/internalsphere/Nexus' }]),
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
      'acme/anyexpenses',
      'internalsphere/nexus',
      NO_REPO_GROUP,
    ]);
    expect(groups[0]!.agents.map((a) => a.id)).toEqual(['c', 'e']);
    expect(groups[1]!.agents.map((a) => a.id)).toEqual(['a', 'b', 'e']);
    expect(groups[2]!.agents.map((a) => a.id)).toEqual(['d']);
  });

  it('combines repos that differ only by casing', () => {
    const groups = groupAgentsByRepo([
      {
        id: 'lower',
        name: 'lower',
        createdAt: '2026-07-30T12:00:00.000Z',
        repos: [{ url: 'https://github.com/internalsphere/nexus' }],
      },
      {
        id: 'upper',
        name: 'upper',
        createdAt: '2026-07-29T12:00:00.000Z',
        repos: [{ url: 'https://github.com/InternalSphere/Nexus' }],
      },
      {
        id: 'mixed',
        name: 'mixed',
        createdAt: '2026-07-28T12:00:00.000Z',
        repos: [
          { url: 'https://github.com/internalsphere/Nexus' },
          { url: 'https://github.com/internalsphere/nexus' },
        ],
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.repo).toBe('internalsphere/nexus');
    expect(groups[0]!.agents.map((a) => a.id)).toEqual([
      'lower',
      'upper',
      'mixed',
    ]);
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

  it('parses GitHub PR refs and short number labels', () => {
    expect(
      parseGithubPrRef('https://github.com/internalsphere/nexus/pull/28'),
    ).toEqual({
      owner: 'internalsphere',
      repo: 'nexus',
      number: 28,
      prUrl: 'https://github.com/internalsphere/nexus/pull/28',
    });
    expect(parseGithubPrRef('https://gitlab.com/acme/x/merge_requests/1')).toBeNull();
    expect(
      formatPrNumberLabel('https://github.com/internalsphere/nexus/pull/28'),
    ).toBe('#28');
    expect(formatPrNumberLabel('internalsphere/nexus#31')).toBe('#31');
  });

  it('prefers GitHub PR titles, else oldest conversation name', () => {
    expect(
      resolvePrDisplayName({
        prTitle: 'Monitoring: repositories as projects',
        conversations: [
          { name: 'Follow-up', createdAt: '2026-07-30T10:00:00.000Z' },
        ],
      }),
    ).toBe('Monitoring: repositories as projects');

    expect(
      resolvePrDisplayName({
        conversations: [
          { name: 'Follow-up fix', createdAt: '2026-07-30T10:00:00.000Z' },
          {
            name: 'Monitoring: repositories as projects',
            createdAt: '2026-07-28T10:00:00.000Z',
          },
        ],
      }),
    ).toBe('Monitoring: repositories as projects');

    expect(resolvePrDisplayName({ conversations: [] })).toBeNull();
  });

  it('attaches resolved GitHub titles onto PR groups', async () => {
    const groups = groupConversationsByPr(agents);
    const withTitles = await attachGithubPrTitles(groups, async () => {
      return new Map([[PR_A, 'Monitoring: repositories as projects']]);
    });
    expect(withTitles.find((g) => g.key === PR_A)?.pr?.title).toBe(
      'Monitoring: repositories as projects',
    );
    expect(withTitles.find((g) => g.key === PR_B)?.pr?.title).toBeUndefined();
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

describe('automation vs user-request partitioning', () => {
  it('detects automation metadata from agent fields', () => {
    expect(
      automationMetaFromRun({
        automationId: 'auto-1',
        automationName: 'PR Review',
      }),
    ).toEqual({ automationId: 'auto-1', automationName: 'PR Review' });
    expect(automationMetaFromRun({ source: 'automations' })?.automationId).toBe(
      '__unscoped_automation__',
    );
    expect(automationMetaFromRun({})).toBeNull();
    expect(automationDisplayName('7fc64f90-6d7a-4a5d-91b1-bd1f529a85dd')).toBe(
      'Automation 7fc64f90',
    );
  });

  it('buckets automations and user requests with cost sorting', () => {
    const runs = [
      {
        id: 'u1',
        name: 'User expensive',
        chargedCents: 500,
        createdAt: '2026-07-30T10:00:00.000Z',
      },
      {
        id: 'a1',
        name: 'Auto cheap run',
        automationId: 'auto-hi',
        automationName: 'High Cost Auto',
        chargedCents: 100,
        createdAt: '2026-07-29T10:00:00.000Z',
        prUrl: 'https://github.com/acme/web/pull/1',
        prNumber: '#1',
      },
      {
        id: 'a2',
        name: 'Auto expensive run',
        automationId: 'auto-hi',
        automationName: 'High Cost Auto',
        chargedCents: 400,
        createdAt: '2026-07-30T09:00:00.000Z',
      },
      {
        id: 'a3',
        name: 'Other auto',
        automationId: 'auto-lo',
        automationName: 'Low Cost Auto',
        chargedCents: 50,
        createdAt: '2026-07-28T10:00:00.000Z',
      },
      {
        id: 'u2',
        name: 'User cheap',
        chargedCents: 10,
        createdAt: '2026-07-31T10:00:00.000Z',
      },
    ];

    const byCost = partitionProjectRunsByAutomation(runs, 'cost');
    expect(byCost.automations.map((a) => a.automationId)).toEqual([
      'auto-hi',
      'auto-lo',
    ]);
    expect(byCost.automations[0]!.totalChargedCents).toBe(500);
    expect(byCost.automations[0]!.conversations.map((c) => c.id)).toEqual([
      'a2',
      'a1',
    ]);
    expect(byCost.userRequests.map((r) => r.id)).toEqual(['u1', 'u2']);

    const byCreated = partitionProjectRunsByAutomation(runs, 'created');
    expect(byCreated.userRequests.map((r) => r.id)).toEqual(['u2', 'u1']);
  });

  it('partitions enriched agents and attributes PR-derived repos', () => {
    const agents: EnrichedAgent[] = [
      {
        ...conversation('auto', ['https://github.com/acme/web/pull/9'], 80, '2026-07-30T10:00:00.000Z'),
        automationId: 'auto-1',
        automationName: 'Nightly',
        repos: [],
      },
      conversation('user', ['https://github.com/acme/web/pull/8'], 20, '2026-07-29T10:00:00.000Z'),
    ];
    agents[1]!.repos = [{ url: 'https://github.com/acme/web' }];

    expect(agentRepoLabelsIncludingPrs(agents[0]!)).toEqual(['acme/web']);
    const groups = groupEnrichedAgentsByRepo(agents);
    expect(groups.map((g) => g.repo)).toEqual(['acme/web']);
    expect(groups[0]!.agents.map((a) => a.id).sort()).toEqual(['auto', 'user']);

    const sections = partitionProjectRuns(agents, 'cost');
    expect(sections.automations).toHaveLength(1);
    expect(sections.automations[0]!.automationName).toBe('Nightly');
    expect(sections.automations[0]!.totalChargedCents).toBe(80);
    expect(sections.userRequests.map((a) => a.id)).toEqual(['user']);
  });

  it('applies Admin usage automation attribution onto agents', async () => {
    const admin = {
      listAllFilteredUsageEvents: async () => ({
        items: [
          {
            timestamp: '1',
            cloudAgentId: 'bc-1',
            automationId: 'auto-9',
          },
        ],
        truncated: false,
      }),
    } as unknown as CursorAdminClient;

    const map = await loadAutomationAttributionMap(admin);
    expect(map.get('bc-1')).toEqual({ automationId: 'auto-9' });

    const stamped = applyAutomationAttribution(
      [conversation('bc-1', [], 10, '2026-07-30T10:00:00.000Z')],
      map,
    );
    expect(stamped[0]!.automationId).toBe('auto-9');
    expect(stamped[0]!.source).toBe('automations');
  });
});
