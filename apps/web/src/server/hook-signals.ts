import { desc } from 'drizzle-orm';
import { cursorStopHookEvents, getDb } from '@nexus/db';

export type HookSignalEvent = {
  id: string;
  userEmail: string | null;
  repo: string | null;
  gitBranch: string | null;
  workspaceRoot: string | null;
  conversationId: string | null;
  generationId: string | null;
  model: string | null;
  status: string | null;
  loopCount: number | null;
  cursorVersion: string | null;
  receivedAt: string;
};

export type HookConversationBucket = {
  conversationId: string;
  events: HookSignalEvent[];
  latestAt: string;
  statuses: Record<string, number>;
};

export type HookRepoBucket = {
  repo: string;
  branches: string[];
  conversations: HookConversationBucket[];
  eventCount: number;
  latestAt: string;
};

export type HookUserBucket = {
  userEmail: string;
  repos: HookRepoBucket[];
  eventCount: number;
  latestAt: string;
};

export type HookSignalsTree = {
  users: HookUserBucket[];
  totalEvents: number;
  truncated: boolean;
};

const UNKNOWN_USER = 'Unknown user';
const UNKNOWN_REPO = 'Unknown repo';
const UNKNOWN_CONVERSATION = 'Unknown conversation';

export async function loadHookSignalsTree(limit = 500): Promise<HookSignalsTree> {
  const rows = await getDb()
    .select({
      id: cursorStopHookEvents.id,
      userEmail: cursorStopHookEvents.userEmail,
      repo: cursorStopHookEvents.repo,
      gitBranch: cursorStopHookEvents.gitBranch,
      workspaceRoot: cursorStopHookEvents.workspaceRoot,
      conversationId: cursorStopHookEvents.conversationId,
      generationId: cursorStopHookEvents.generationId,
      model: cursorStopHookEvents.model,
      status: cursorStopHookEvents.status,
      loopCount: cursorStopHookEvents.loopCount,
      cursorVersion: cursorStopHookEvents.cursorVersion,
      receivedAt: cursorStopHookEvents.receivedAt,
    })
    .from(cursorStopHookEvents)
    .orderBy(desc(cursorStopHookEvents.receivedAt))
    .limit(limit);

  const events: HookSignalEvent[] = rows.map((r) => ({
    id: r.id,
    userEmail: r.userEmail,
    repo: r.repo,
    gitBranch: r.gitBranch,
    workspaceRoot: r.workspaceRoot,
    conversationId: r.conversationId,
    generationId: r.generationId,
    model: r.model,
    status: r.status,
    loopCount: r.loopCount,
    cursorVersion: r.cursorVersion,
    receivedAt:
      r.receivedAt instanceof Date
        ? r.receivedAt.toISOString()
        : String(r.receivedAt),
  }));

  return buildHookSignalsTree(events, rows.length >= limit);
}

export function buildHookSignalsTree(
  events: HookSignalEvent[],
  truncated = false,
): HookSignalsTree {
  type ConvAcc = {
    conversationId: string;
    events: HookSignalEvent[];
  };
  type RepoAcc = {
    repo: string;
    branches: Set<string>;
    conversations: Map<string, ConvAcc>;
  };
  type UserAcc = {
    userEmail: string;
    repos: Map<string, RepoAcc>;
  };

  const users = new Map<string, UserAcc>();

  for (const event of events) {
    const userKey = event.userEmail?.trim() || UNKNOWN_USER;
    const repoKey = event.repo?.trim() || UNKNOWN_REPO;
    const convKey = event.conversationId?.trim() || UNKNOWN_CONVERSATION;

    let user = users.get(userKey);
    if (!user) {
      user = { userEmail: userKey, repos: new Map() };
      users.set(userKey, user);
    }

    let repo = user.repos.get(repoKey);
    if (!repo) {
      repo = { repo: repoKey, branches: new Set(), conversations: new Map() };
      user.repos.set(repoKey, repo);
    }
    if (event.gitBranch?.trim()) repo.branches.add(event.gitBranch.trim());

    let conv = repo.conversations.get(convKey);
    if (!conv) {
      conv = { conversationId: convKey, events: [] };
      repo.conversations.set(convKey, conv);
    }
    conv.events.push(event);
  }

  const userBuckets: HookUserBucket[] = [...users.values()].map((user) => {
    const repos: HookRepoBucket[] = [...user.repos.values()].map((repo) => {
      const conversations: HookConversationBucket[] = [
        ...repo.conversations.values(),
      ].map((conv) => {
        const statuses: Record<string, number> = {};
        for (const e of conv.events) {
          const s = e.status ?? 'unknown';
          statuses[s] = (statuses[s] ?? 0) + 1;
        }
        return {
          conversationId: conv.conversationId,
          events: conv.events,
          latestAt: conv.events[0]?.receivedAt ?? '',
          statuses,
        };
      });
      conversations.sort((a, b) => b.latestAt.localeCompare(a.latestAt));

      const eventCount = conversations.reduce((n, c) => n + c.events.length, 0);
      return {
        repo: repo.repo,
        branches: [...repo.branches].sort(),
        conversations,
        eventCount,
        latestAt: conversations[0]?.latestAt ?? '',
      };
    });
    repos.sort((a, b) => b.latestAt.localeCompare(a.latestAt));

    const eventCount = repos.reduce((n, r) => n + r.eventCount, 0);
    return {
      userEmail: user.userEmail,
      repos,
      eventCount,
      latestAt: repos[0]?.latestAt ?? '',
    };
  });

  userBuckets.sort((a, b) => b.latestAt.localeCompare(a.latestAt));

  return {
    users: userBuckets,
    totalEvents: events.length,
    truncated,
  };
}
