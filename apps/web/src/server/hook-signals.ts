import { desc } from 'drizzle-orm';
import { cursorStopHookEvents, getDb } from '@nexus/db';

/** Aligns with Monitoring's {@link NO_REPO_GROUP} in `cursor.ts`. */
export const HOOK_NO_REPO_GROUP = 'No repository';

export type HookSignalEvent = {
  id: string;
  userEmail: string | null;
  repo: string | null;
  gitBranch: string | null;
  workspaceRoot: string | null;
  conversationId: string | null;
  generationId: string | null;
  model: string | null;
  modelId: string | null;
  hookEventName: string | null;
  status: string | null;
  loopCount: number | null;
  cursorVersion: string | null;
  transcriptPath: string | null;
  workspaceRoots: unknown[];
  modelParams: Array<{ id: string; value: string }> | null;
  chargedCents: number | null;
  costSource: string | null;
  costLookupError: string | null;
  usageEvent: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  receivedAt: string;
};

export type HookConversationBucket = {
  conversationId: string;
  userEmail: string | null;
  events: HookSignalEvent[];
  latestAt: string;
  statuses: Record<string, number>;
  chargedCentsTotal: number | null;
};

export type HookRepoBucket = {
  /** Canonical monitoring repo key (lowercased owner/repo) or no-repo sentinel. */
  repo: string;
  branches: string[];
  conversations: HookConversationBucket[];
  eventCount: number;
  latestAt: string;
  chargedCentsTotal: number | null;
};

/** Repo-aggregated hook signals (local requests). */
export type HookSignalsTree = {
  repos: HookRepoBucket[];
  totalEvents: number;
  truncated: boolean;
};

export type HookRepoSummary = {
  repo: string;
  eventCount: number;
  conversationCount: number;
  totalChargedCents: number | null;
  latestAt: string | null;
};

const UNKNOWN_CONVERSATION = 'Unknown conversation';

function normalizeRepoKey(label: string): string {
  return label.trim().toLowerCase();
}

function mapRowToEvent(r: typeof cursorStopHookEvents.$inferSelect): HookSignalEvent {
  return {
    id: r.id,
    userEmail: r.userEmail,
    repo: r.repo,
    gitBranch: r.gitBranch,
    workspaceRoot: r.workspaceRoot,
    conversationId: r.conversationId,
    generationId: r.generationId,
    model: r.model,
    modelId: r.modelId,
    hookEventName: r.hookEventName,
    status: r.status,
    loopCount: r.loopCount,
    cursorVersion: r.cursorVersion,
    transcriptPath: r.transcriptPath,
    workspaceRoots: Array.isArray(r.workspaceRoots) ? r.workspaceRoots : [],
    modelParams: r.modelParams ?? null,
    chargedCents:
      typeof r.chargedCents === 'number' && Number.isFinite(r.chargedCents)
        ? r.chargedCents
        : null,
    costSource: r.costSource,
    costLookupError: r.costLookupError,
    usageEvent: r.usageEvent ?? null,
    payload: r.payload ?? {},
    receivedAt:
      r.receivedAt instanceof Date
        ? r.receivedAt.toISOString()
        : String(r.receivedAt),
  };
}

/** Canonical repo key aligned with Monitoring project labels. */
export function canonicalHookRepo(repo: string | null | undefined): string {
  const trimmed = repo?.trim();
  if (!trimmed) return HOOK_NO_REPO_GROUP;
  return normalizeRepoKey(trimmed);
}

export async function loadHookSignalsTree(limit = 500): Promise<HookSignalsTree> {
  const rows = await getDb()
    .select()
    .from(cursorStopHookEvents)
    .orderBy(desc(cursorStopHookEvents.receivedAt))
    .limit(limit);

  const events = rows.map(mapRowToEvent);
  return buildHookSignalsTree(events, rows.length >= limit);
}

/** Hook signals for one Monitoring project (repository). */
export async function loadHookSignalsForRepo(
  repo: string,
  limit = 500,
): Promise<HookRepoBucket | null> {
  const canonical =
    repo === HOOK_NO_REPO_GROUP ? HOOK_NO_REPO_GROUP : normalizeRepoKey(repo);
  const tree = await loadHookSignalsTree(limit);
  return tree.repos.find((r) => r.repo === canonical) ?? null;
}

export function summarizeHookRepos(tree: HookSignalsTree): HookRepoSummary[] {
  return tree.repos.map((repo) => ({
    repo: repo.repo,
    eventCount: repo.eventCount,
    conversationCount: repo.conversations.length,
    totalChargedCents: repo.chargedCentsTotal,
    latestAt: repo.latestAt || null,
  }));
}

/**
 * Aggregate stop-hook events by repository → conversation.
 * Repos are lowercased so they merge with Monitoring Cloud Agent projects.
 */
export function buildHookSignalsTree(
  events: HookSignalEvent[],
  truncated = false,
): HookSignalsTree {
  type ConvAcc = {
    conversationId: string;
    userEmail: string | null;
    events: HookSignalEvent[];
  };
  type RepoAcc = {
    repo: string;
    branches: Set<string>;
    conversations: Map<string, ConvAcc>;
  };

  const repos = new Map<string, RepoAcc>();

  for (const event of events) {
    const repoKey = canonicalHookRepo(event.repo);
    const convKey = event.conversationId?.trim() || UNKNOWN_CONVERSATION;

    let repo = repos.get(repoKey);
    if (!repo) {
      repo = { repo: repoKey, branches: new Set(), conversations: new Map() };
      repos.set(repoKey, repo);
    }
    if (event.gitBranch?.trim()) repo.branches.add(event.gitBranch.trim());

    let conv = repo.conversations.get(convKey);
    if (!conv) {
      conv = {
        conversationId: convKey,
        userEmail: event.userEmail?.trim() || null,
        events: [],
      };
      repo.conversations.set(convKey, conv);
    } else if (!conv.userEmail && event.userEmail?.trim()) {
      conv.userEmail = event.userEmail.trim();
    }
    conv.events.push(event);
  }

  const repoBuckets: HookRepoBucket[] = [...repos.values()].map((repo) => {
    const conversations: HookConversationBucket[] = [
      ...repo.conversations.values(),
    ].map((conv) => {
      const statuses: Record<string, number> = {};
      let chargedSum = 0;
      let chargedAny = false;
      for (const e of conv.events) {
        const s = e.status ?? 'unknown';
        statuses[s] = (statuses[s] ?? 0) + 1;
        if (typeof e.chargedCents === 'number') {
          chargedSum += e.chargedCents;
          chargedAny = true;
        }
      }
      return {
        conversationId: conv.conversationId,
        userEmail: conv.userEmail,
        events: conv.events,
        latestAt: conv.events[0]?.receivedAt ?? '',
        statuses,
        chargedCentsTotal: chargedAny ? chargedSum : null,
      };
    });
    conversations.sort((a, b) => b.latestAt.localeCompare(a.latestAt));

    const eventCount = conversations.reduce((n, c) => n + c.events.length, 0);
    let chargedSum = 0;
    let chargedAny = false;
    for (const c of conversations) {
      if (c.chargedCentsTotal != null) {
        chargedSum += c.chargedCentsTotal;
        chargedAny = true;
      }
    }

    return {
      repo: repo.repo,
      branches: [...repo.branches].sort(),
      conversations,
      eventCount,
      latestAt: conversations[0]?.latestAt ?? '',
      chargedCentsTotal: chargedAny ? chargedSum : null,
    };
  });

  repoBuckets.sort((a, b) => {
    if (a.repo === HOOK_NO_REPO_GROUP) return 1;
    if (b.repo === HOOK_NO_REPO_GROUP) return -1;
    return b.latestAt.localeCompare(a.latestAt);
  });

  return {
    repos: repoBuckets,
    totalEvents: events.length,
    truncated,
  };
}

/**
 * Merge Cloud Agent project summaries with local-request (hook) repo totals.
 * Hook-only repos appear as projects; shared repos sum charged cents and
 * take the newer latestAt.
 */
export function mergeProjectsWithHookSummaries<
  T extends {
    repo: string;
    conversationCount: number;
    prCount: number;
    totalChargedCents: number | null;
    totalRawCents: number | null;
    latestCreatedAt: string | null;
  },
>(cloudProjects: T[], hookRepos: HookRepoSummary[]): T[] {
  const byRepo = new Map<string, T>();

  for (const project of cloudProjects) {
    byRepo.set(project.repo, { ...project });
  }

  for (const hook of hookRepos) {
    const existing = byRepo.get(hook.repo);
    if (!existing) {
      byRepo.set(hook.repo, {
        repo: hook.repo,
        conversationCount: hook.conversationCount,
        prCount: 0,
        totalChargedCents: hook.totalChargedCents,
        totalRawCents: null,
        latestCreatedAt: hook.latestAt,
      } as T);
      continue;
    }

    const charged =
      existing.totalChargedCents != null || hook.totalChargedCents != null
        ? (existing.totalChargedCents ?? 0) + (hook.totalChargedCents ?? 0)
        : null;
    const existingMs = existing.latestCreatedAt
      ? Date.parse(existing.latestCreatedAt)
      : 0;
    const hookMs = hook.latestAt ? Date.parse(hook.latestAt) : 0;
    byRepo.set(hook.repo, {
      ...existing,
      conversationCount: existing.conversationCount + hook.conversationCount,
      totalChargedCents: charged,
      latestCreatedAt:
        hookMs > existingMs ? hook.latestAt : existing.latestCreatedAt,
    });
  }

  const noRepo = [...byRepo.values()].filter((p) => p.repo === HOOK_NO_REPO_GROUP);
  const rest = [...byRepo.values()].filter((p) => p.repo !== HOOK_NO_REPO_GROUP);
  rest.sort((a, b) => {
    const at = a.latestCreatedAt ? Date.parse(a.latestCreatedAt) : 0;
    const bt = b.latestCreatedAt ? Date.parse(b.latestCreatedAt) : 0;
    if (at !== bt) return bt - at;
    return a.repo.localeCompare(b.repo);
  });
  return [...rest, ...noRepo];
}
