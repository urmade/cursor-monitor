import {
  buildMonitorTree,
  canonicalRepository,
  preferenceMap,
  resolveMergeRoot,
  type MonitorHookRecord,
  type MonitorTree,
  type MonitorUsageRecord,
  type RepositoryPreference,
} from '@cursor-monitor/core';
import {
  branchPreferences,
  conversationPreferences,
  getDb,
  hookEvents,
  repositoryPreferences,
  syncRuns,
  teamUsageEvents,
} from '@cursor-monitor/db';
import { count, desc, eq, inArray, sql } from 'drizzle-orm';

const HOOK_LIMIT = 5000;
const USAGE_LIMIT = 10_000;

function iso(value: Date): string {
  return value.toISOString();
}

export type LoadedMonitorData = {
  tree: MonitorTree;
  hooksTruncated: boolean;
  usageTruncated: boolean;
  hookCount: number;
  usageCount: number;
  mergeRootsWithChildren: Set<string>;
};

export async function loadMonitorData(): Promise<LoadedMonitorData> {
  const db = getDb();
  const [
    hooks,
    usage,
    repoPrefs,
    conversationPrefs,
    hookTotal,
    usageTotal,
  ] = await Promise.all([
    db
      .select({
        id: hookEvents.id,
        eventName: hookEvents.eventName,
        conversationId: hookEvents.conversationId,
        conversationKey: hookEvents.conversationKey,
        generationId: hookEvents.generationId,
        repositoryKey: hookEvents.repositoryKey,
        repositoryLabel: hookEvents.repositoryLabel,
        gitBranch: hookEvents.gitBranch,
        workspaceRoot: hookEvents.workspaceRoot,
        userEmail: hookEvents.userEmail,
        model: hookEvents.model,
        status: hookEvents.status,
        durationMs: hookEvents.durationMs,
        payload: sql<Record<string, unknown>>`'{}'::jsonb`,
        occurredAt: hookEvents.occurredAt,
        receivedAt: hookEvents.receivedAt,
      })
      .from(hookEvents)
      .orderBy(desc(hookEvents.occurredAt))
      .limit(HOOK_LIMIT),
    db
      .select({
        fingerprint: teamUsageEvents.fingerprint,
        conversationId: teamUsageEvents.conversationId,
        conversationKey: teamUsageEvents.conversationKey,
        userEmail: teamUsageEvents.userEmail,
        model: teamUsageEvents.model,
        kind: teamUsageEvents.kind,
        chargedCents: teamUsageEvents.chargedCents,
        occurredAt: teamUsageEvents.occurredAt,
      })
      .from(teamUsageEvents)
      .orderBy(desc(teamUsageEvents.occurredAt))
      .limit(USAGE_LIMIT),
    db.select().from(repositoryPreferences),
    db.select().from(conversationPreferences),
    db.select({ value: count() }).from(hookEvents),
    db.select({ value: count() }).from(teamUsageEvents),
  ]);

  const hookRecords: MonitorHookRecord[] = hooks.map((row) => ({
    ...row,
    occurredAt: iso(row.occurredAt),
    receivedAt: iso(row.receivedAt),
  }));
  const usageRecords: MonitorUsageRecord[] = usage.map((row) => ({
    fingerprint: row.fingerprint,
    conversationId: row.conversationId,
    conversationKey: row.conversationKey,
    userEmail: row.userEmail,
    model: row.model,
    kind: row.kind,
    chargedCents: row.chargedCents,
    occurredAt: iso(row.occurredAt),
  }));
  const preferences: RepositoryPreference[] = repoPrefs.map((row) => ({
    repositoryKey: row.repositoryKey,
    displayName: row.displayName,
    mergedIntoKey: row.mergedIntoKey,
  }));
  const names = new Map(
    conversationPrefs.map((row) => [row.conversationKey, row.displayName]),
  );
  const preferencesByRepo = preferenceMap(preferences);
  const mergeRootsWithChildren = new Set(
    preferences
      .filter((preference) => preference.mergedIntoKey)
      .map((preference) =>
        resolveMergeRoot(preference.repositoryKey, preferencesByRepo),
      ),
  );
  const hookCount = Number(hookTotal[0]?.value ?? 0);
  const usageCount = Number(usageTotal[0]?.value ?? 0);

  return {
    tree: buildMonitorTree({
      hooks: hookRecords,
      usage: usageRecords,
      repositoryPreferences: preferences,
      conversationNames: names,
    }),
    hooksTruncated: hookCount > hooks.length,
    usageTruncated: usageCount > usage.length,
    hookCount,
    usageCount,
    mergeRootsWithChildren,
  };
}

export async function loadRepositoryProject(repository: string) {
  const data = await loadMonitorData();
  const key = canonicalRepository(repository);
  const project = data.tree.projects.find((candidate) => candidate.key === key) ?? null;
  const preferences = await loadRepositoryPreferences();
  const preferencesByRepo = preferenceMap(preferences);
  const eventIds =
    project?.conversations.flatMap((conversation) =>
      conversation.events.map((event) => event.id),
    ) ?? [];
  const hydratedIds = eventIds.slice(0, 1000);
  const rawPayloads =
    hydratedIds.length > 0
      ? await getDb()
          .select({ id: hookEvents.id, payload: hookEvents.payload })
          .from(hookEvents)
          .where(inArray(hookEvents.id, hydratedIds))
      : [];
  const payloadById = new Map(rawPayloads.map((row) => [row.id, row.payload]));
  const hydratedProject = project
    ? {
        ...project,
        conversations: project.conversations.map((conversation) => ({
          ...conversation,
          events: conversation.events.map((event) => ({
            ...event,
            payload: payloadById.get(event.id) ?? {},
          })),
        })),
      }
    : null;
  return {
    ...data,
    project: hydratedProject,
    rawPayloadsTruncated: eventIds.length > hydratedIds.length,
    attachedRepositories: hydratedProject
      ? preferences
          .map((preference) => preference.repositoryKey)
          .filter(
            (candidate) =>
              candidate !== hydratedProject.key &&
              resolveMergeRoot(candidate, preferencesByRepo) ===
                hydratedProject.key,
          )
          .sort()
      : [],
  };
}

export async function loadRepositoryPreferences(): Promise<
  RepositoryPreference[]
> {
  const rows = await getDb().select().from(repositoryPreferences);
  return rows.map((row) => ({
    repositoryKey: row.repositoryKey,
    displayName: row.displayName,
    mergedIntoKey: row.mergedIntoKey,
  }));
}

export async function loadBranchNames(
  repository: string,
): Promise<Map<string, string>> {
  const key = canonicalRepository(repository);
  const rows = await getDb()
    .select()
    .from(branchPreferences)
    .where(eq(branchPreferences.repositoryKey, key));
  return new Map(rows.map((row) => [row.branchKey, row.displayName]));
}

export async function loadSyncStatus() {
  const rows = await getDb()
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(10);
  return rows.map((row) => ({
    ...row,
    windowStartedAt: iso(row.windowStartedAt),
    windowEndedAt: iso(row.windowEndedAt),
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : null,
  }));
}

export function loadConfigurationStatus() {
  const organization =
    Boolean(process.env.CURSOR_ORGANIZATION_API_KEY?.trim()) &&
    Boolean(process.env.CURSOR_ORGANIZATION_ID?.trim());
  return {
    teamApi: organization || Boolean(process.env.CURSOR_TEAM_API_KEY?.trim()),
    teamApiMode: organization
      ? 'Organization API'
      : process.env.CURSOR_TEAM_API_KEY?.trim()
        ? 'Team API'
        : null,
    hookToken: Boolean(
      process.env.CURSOR_MONITOR_HOOK_TOKEN?.trim(),
    ),
    cronSecret: Boolean(process.env.CRON_SECRET?.trim()),
  };
}
