import {
  canonicalConversation,
  canonicalRepository,
  displayConversationKey,
  displayRepositoryKey,
  NO_REPOSITORY_KEY,
  UNKNOWN_CONVERSATION_KEY,
} from './identity';
import {
  preferenceMap,
  resolveMergeRoot,
  type RepositoryPreference,
} from './preferences';

export type MonitorHookRecord = {
  id: string;
  eventName: string;
  conversationId: string | null;
  conversationKey: string | null;
  generationId: string | null;
  repositoryKey: string | null;
  repositoryLabel: string | null;
  gitBranch: string | null;
  workspaceRoot: string | null;
  userEmail: string | null;
  model: string | null;
  status: string | null;
  durationMs: number | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
};

export type MonitorUsageRecord = {
  fingerprint: string;
  conversationId: string | null;
  conversationKey: string | null;
  userEmail: string | null;
  model: string | null;
  kind: string | null;
  chargedCents: number | null;
  occurredAt: string;
};

export type MonitorConversation = {
  key: string;
  id: string | null;
  displayName: string;
  repositoryKey: string;
  /** Canonical repository reported by the newest hook event. */
  originatingRepository: string;
  sourceRepositories: string[];
  branch: string | null;
  userEmail: string | null;
  model: string | null;
  status: string | null;
  latestAt: string;
  durationMs: number | null;
  chargedCents: number | null;
  usageEventCount: number;
  events: MonitorHookRecord[];
};

export type MonitorProject = {
  key: string;
  displayName: string;
  sourceRepositories: string[];
  latestAt: string;
  conversationCount: number;
  eventCount: number;
  chargedCents: number | null;
  conversations: MonitorConversation[];
};

export type MonitorTree = {
  projects: MonitorProject[];
  totalHookEvents: number;
  totalUsageEvents: number;
  unmatchedUsageEvents: number;
  chargedCents: number | null;
};

type ConversationUsage = {
  count: number;
  chargedCents: number | null;
};

function usageByConversation(
  usage: readonly MonitorUsageRecord[],
): Map<string, ConversationUsage> {
  const result = new Map<string, ConversationUsage>();
  for (const event of usage) {
    const key = canonicalConversation(event.conversationKey ?? event.conversationId);
    if (key === UNKNOWN_CONVERSATION_KEY) continue;
    const current = result.get(key) ?? { count: 0, chargedCents: null };
    current.count += 1;
    if (typeof event.chargedCents === 'number' && Number.isFinite(event.chargedCents)) {
      current.chargedCents = (current.chargedCents ?? 0) + event.chargedCents;
    }
    result.set(key, current);
  }
  return result;
}

function hookConversationKey(event: MonitorHookRecord): string {
  const canonical = canonicalConversation(
    event.conversationKey ?? event.conversationId,
  );
  if (canonical !== UNKNOWN_CONVERSATION_KEY) return canonical;
  const generation = event.generationId?.trim().toLowerCase();
  return generation ? `generation:${generation}` : `event:${event.id}`;
}

export function buildMonitorTree(options: {
  hooks: readonly MonitorHookRecord[];
  usage: readonly MonitorUsageRecord[];
  repositoryPreferences?: readonly RepositoryPreference[];
  conversationNames?: ReadonlyMap<string, string>;
}): MonitorTree {
  const preferences = preferenceMap(options.repositoryPreferences ?? []);
  const conversationNames = options.conversationNames ?? new Map();
  const orderedHooks = [...options.hooks].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  );
  const usage = usageByConversation(options.usage);

  // A conversation belongs to the repository from its newest hook. This avoids
  // double-counting Team usage if an old event reported a different repository.
  const ownerByConversation = new Map<string, string>();
  for (const event of orderedHooks) {
    const conversationKey = hookConversationKey(event);
    if (!ownerByConversation.has(conversationKey)) {
      ownerByConversation.set(
        conversationKey,
        resolveMergeRoot(
          canonicalRepository(event.repositoryKey ?? event.repositoryLabel),
          preferences,
        ),
      );
    }
  }

  type ConversationAccumulator = {
    key: string;
    id: string | null;
    events: MonitorHookRecord[];
    sources: Set<string>;
  };
  type ProjectAccumulator = {
    key: string;
    sources: Set<string>;
    conversations: Map<string, ConversationAccumulator>;
  };

  const projects = new Map<string, ProjectAccumulator>();
  for (const event of orderedHooks) {
    const conversationKey = hookConversationKey(event);
    const rawRepository = canonicalRepository(
      event.repositoryKey ?? event.repositoryLabel,
    );
    const root =
      ownerByConversation.get(conversationKey) ??
      resolveMergeRoot(rawRepository, preferences);
    let project = projects.get(root);
    if (!project) {
      project = {
        key: root,
        sources: new Set(),
        conversations: new Map(),
      };
      projects.set(root, project);
    }
    project.sources.add(rawRepository);
    let conversation = project.conversations.get(conversationKey);
    if (!conversation) {
      conversation = {
        key: conversationKey,
        id: event.conversationId,
        events: [],
        sources: new Set(),
      };
      project.conversations.set(conversationKey, conversation);
    }
    conversation.sources.add(rawRepository);
    conversation.events.push(event);
  }

  const matchedConversationKeys = new Set<string>();
  const projectViews: MonitorProject[] = [...projects.values()].map((project) => {
    const conversations: MonitorConversation[] = [
      ...project.conversations.values(),
    ].map((conversation) => {
      const latest = conversation.events[0]!;
      const matchedUsage = usage.get(conversation.key);
      if (matchedUsage) matchedConversationKeys.add(conversation.key);
      const explicitName = conversationNames.get(conversation.key)?.trim();
      return {
        key: conversation.key,
        id: conversation.id,
        displayName:
          explicitName ||
          latest.userEmail?.trim() ||
          displayConversationKey(conversation.key),
        repositoryKey: project.key,
        originatingRepository: canonicalRepository(
          latest.repositoryKey ?? latest.repositoryLabel,
        ),
        sourceRepositories: [...conversation.sources].sort(),
        branch:
          conversation.events
            .map((event) => event.gitBranch?.trim())
            .find(Boolean) ?? null,
        userEmail:
          conversation.events
            .map((event) => event.userEmail?.trim())
            .find(Boolean) ?? null,
        model:
          conversation.events
            .map((event) => event.model?.trim())
            .find(Boolean) ?? null,
        status: latest.status,
        latestAt: latest.occurredAt,
        durationMs: (() => {
          const durations = conversation.events
            .map((event) => event.durationMs)
            .filter((value): value is number => value != null);
          return durations.length > 0
            ? durations.reduce((total, value) => total + value, 0)
            : null;
        })(),
        chargedCents: matchedUsage?.chargedCents ?? null,
        usageEventCount: matchedUsage?.count ?? 0,
        events: conversation.events,
      };
    });
    conversations.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
    const chargedValues = conversations
      .map((conversation) => conversation.chargedCents)
      .filter((value): value is number => value != null);
    const pref = preferences.get(project.key);
    return {
      key: project.key,
      displayName:
        pref?.displayName?.trim() || displayRepositoryKey(project.key),
      sourceRepositories: [...project.sources].sort((a, b) => {
        if (a === project.key) return -1;
        if (b === project.key) return 1;
        return a.localeCompare(b);
      }),
      latestAt: conversations[0]?.latestAt ?? '',
      conversationCount: conversations.length,
      eventCount: conversations.reduce(
        (total, conversation) => total + conversation.events.length,
        0,
      ),
      chargedCents:
        chargedValues.length > 0
          ? chargedValues.reduce((total, value) => total + value, 0)
          : null,
      conversations,
    };
  });

  projectViews.sort((a, b) => {
    if (a.key === NO_REPOSITORY_KEY) return 1;
    if (b.key === NO_REPOSITORY_KEY) return -1;
    return b.latestAt.localeCompare(a.latestAt);
  });
  const chargedValues = projectViews
    .map((project) => project.chargedCents)
    .filter((value): value is number => value != null);
  const unmatchedUsageEvents = [...usage.entries()]
    .filter(([key]) => !matchedConversationKeys.has(key))
    .reduce((total, [, value]) => total + value.count, 0);

  return {
    projects: projectViews,
    totalHookEvents: options.hooks.length,
    totalUsageEvents: options.usage.length,
    unmatchedUsageEvents,
    chargedCents:
      chargedValues.length > 0
        ? chargedValues.reduce((total, value) => total + value, 0)
        : null,
  };
}
