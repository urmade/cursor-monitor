import { describe, expect, it } from 'vitest';
import {
  formatMergedBranchLabel,
  shortRepoName,
} from '../lib/monitoring-format';
import {
  applyMonitoringRepoPrefs,
  memberReposForRoot,
  prefsByRepo,
  resolveMergeRoot,
  type MonitoringRepoPref,
} from '../server/monitoring-repo-prefs';
import {
  buildHookSignalsTree,
  mergeHookRepoBuckets,
  type HookSignalEvent,
} from '../server/hook-signals';

function pref(
  repo: string,
  patch: Partial<Omit<MonitoringRepoPref, 'repo'>> = {},
): MonitoringRepoPref {
  return {
    repo,
    displayName: null,
    hidden: false,
    mergedIntoRepo: null,
    ...patch,
  };
}

function project(
  repo: string,
  patch: Partial<{
    conversationCount: number;
    eventCount: number;
    totalChargedCents: number | null;
    latestCreatedAt: string | null;
  }> = {},
) {
  return {
    repo,
    conversationCount: patch.conversationCount ?? 1,
    eventCount: patch.eventCount ?? 2,
    totalChargedCents: patch.totalChargedCents ?? 100,
    latestCreatedAt: patch.latestCreatedAt ?? '2026-08-01T12:00:00.000Z',
  };
}

describe('monitoring repo preferences', () => {
  it('shortens owner/repo for branch prefixes', () => {
    expect(shortRepoName('anysphere/repo-a')).toBe('repo-a');
    expect(shortRepoName('repo-b')).toBe('repo-b');
  });

  it('prefixes branches only when merging', () => {
    expect(formatMergedBranchLabel('main', 'anysphere/repo-a', false)).toBe(
      'main',
    );
    expect(formatMergedBranchLabel('main', 'anysphere/repo-a', true)).toBe(
      'repo-a/main',
    );
    expect(formatMergedBranchLabel('main', 'anysphere/repo-b', true)).toBe(
      'repo-b/main',
    );
    expect(formatMergedBranchLabel(null, 'anysphere/repo-a', true)).toBeNull();
    expect(
      formatMergedBranchLabel('repo-a/main', 'anysphere/repo-a', true),
    ).toBe('repo-a/main');
  });

  it('resolves merge roots transitively and detects cycles', () => {
    const prefs = prefsByRepo([
      pref('org/a', { mergedIntoRepo: 'org/b' }),
      pref('org/b', { mergedIntoRepo: 'org/c' }),
    ]);
    expect(resolveMergeRoot('org/a', prefs)).toBe('org/c');
    expect(resolveMergeRoot('org/b', prefs)).toBe('org/c');
    expect(resolveMergeRoot('org/c', prefs)).toBe('org/c');

    const cyclic = prefsByRepo([
      pref('org/x', { mergedIntoRepo: 'org/y' }),
      pref('org/y', { mergedIntoRepo: 'org/x' }),
    ]);
    expect(['org/x', 'org/y']).toContain(resolveMergeRoot('org/x', cyclic));
  });

  it('lists member repos for a merge root', () => {
    const prefs = prefsByRepo([
      pref('org/child', { mergedIntoRepo: 'org/parent' }),
      pref('org/other', { mergedIntoRepo: 'org/parent' }),
    ]);
    expect(
      memberReposForRoot(
        'org/parent',
        ['org/parent', 'org/child', 'org/other', 'org/alone'],
        prefs,
      ),
    ).toEqual(['org/parent', 'org/child', 'org/other']);
  });

  it('hides, renames, and merges projects on the monitoring list', () => {
    const raw = [
      project('org/alpha', {
        eventCount: 3,
        totalChargedCents: 50,
        latestCreatedAt: '2026-08-02T10:00:00.000Z',
      }),
      project('org/beta', {
        eventCount: 4,
        totalChargedCents: 70,
        latestCreatedAt: '2026-08-03T10:00:00.000Z',
      }),
      project('org/gamma', {
        eventCount: 1,
        totalChargedCents: 10,
        latestCreatedAt: '2026-08-01T10:00:00.000Z',
      }),
      project('org/hidden', {
        eventCount: 9,
        totalChargedCents: 200,
        latestCreatedAt: '2026-08-04T10:00:00.000Z',
      }),
    ];
    const prefs = [
      pref('org/beta', { mergedIntoRepo: 'org/alpha' }),
      pref('org/alpha', { displayName: 'Alpha Project' }),
      pref('org/hidden', { hidden: true }),
    ];

    const visible = applyMonitoringRepoPrefs(raw, prefs);
    expect(visible.map((p) => p.repo)).toEqual(['org/alpha', 'org/gamma']);
    const alpha = visible.find((p) => p.repo === 'org/alpha')!;
    expect(alpha.displayName).toBe('Alpha Project');
    expect(alpha.memberRepos).toEqual(['org/alpha', 'org/beta']);
    expect(alpha.eventCount).toBe(7);
    expect(alpha.totalChargedCents).toBe(120);
    expect(alpha.latestCreatedAt).toBe('2026-08-03T10:00:00.000Z');

    const withHidden = applyMonitoringRepoPrefs(raw, prefs, {
      includeHidden: true,
    });
    expect(withHidden.some((p) => p.repo === 'org/hidden' && p.hidden)).toBe(
      true,
    );
  });

  it('formats branch labels without mutating the original key', () => {
    // Display labels are applied in the UI; the branch key itself stays stable.
    expect(formatMergedBranchLabel('feat/auth', 'org/api', true)).toBe(
      'api/feat/auth',
    );
    expect(formatMergedBranchLabel('feat/auth', 'org/api', false)).toBe(
      'feat/auth',
    );
  });
});

describe('merged hook repo buckets', () => {
  function event(
    id: string,
    repo: string,
    branch: string,
    conversationId: string,
  ): HookSignalEvent {
    return {
      id,
      userEmail: null,
      repo,
      gitBranch: branch,
      workspaceRoot: null,
      conversationId,
      generationId: null,
      model: null,
      modelId: null,
      hookEventName: null,
      status: 'completed',
      loopCount: null,
      cursorVersion: null,
      transcriptPath: null,
      workspaceRoots: [],
      modelParams: null,
      chargedCents: 10,
      costSource: null,
      costLookupError: null,
      costLookedUpAt: null,
      usageEvent: null,
      payload: {},
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      receivedAt: '2026-08-01T12:00:00.000Z',
    };
  }

  it('keeps originatingRepo when combining buckets', () => {
    const tree = buildHookSignalsTree([
      event('1', 'org/repo-a', 'main', 'c1'),
      event('2', 'org/repo-b', 'main', 'c2'),
    ]);
    const merged = mergeHookRepoBuckets(
      'org/repo-a',
      ['org/repo-a', 'org/repo-b'],
      tree.repos,
    );
    expect(merged.sourceRepos).toEqual(['org/repo-a', 'org/repo-b']);
    expect(merged.conversations).toHaveLength(2);
    const repos = merged.conversations.map((c) => c.originatingRepo).sort();
    expect(repos).toEqual(['org/repo-a', 'org/repo-b']);
    expect(
      formatMergedBranchLabel(
        merged.conversations.find((c) => c.originatingRepo === 'org/repo-a')!
          .gitBranch,
        'org/repo-a',
        true,
      ),
    ).toBe('repo-a/main');
    expect(
      formatMergedBranchLabel(
        merged.conversations.find((c) => c.originatingRepo === 'org/repo-b')!
          .gitBranch,
        'org/repo-b',
        true,
      ),
    ).toBe('repo-b/main');
  });
});
