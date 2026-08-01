/**
 * Monitoring data cache (agents catalogue + per-agent PR/cost enrichment).
 *
 * Backed by Upstash Redis when configured, with an in-process memory layer for
 * same-instance hits. Supports stale-while-revalidate so repeat visits stay
 * fast even while a background refresh runs.
 */
import { createHash } from 'node:crypto';
import { kvGet, kvSet } from '@nexus/core';
import type { AgentSummary, CursorClient } from '@nexus/cursor-client';
import {
  applyAutomationAttribution,
  createEnvAdminClient,
  loadAutomationAttributionMap,
} from './automation-attribution';
import {
  agentRepoLabels,
  agentRepoLabelsIncludingPrs,
  attachGithubPrTitles,
  enrichAgentsWithPrAndCost,
  groupEnrichedAgentsByRepo,
  NO_REPO_GROUP,
  normalizeRepoLabel,
  partitionProjectRuns,
  sortProjectSummaries,
  summarizeProject,
  type ConversationGroupSort,
  type EnrichedAgent,
  type ProjectRunSections,
  type ProjectSummary,
} from './cursor';

const AGENTS_TTL_SEC = 90;
const AGENTS_STALE_SEC = 10 * 60;
const ENRICH_TTL_SEC = 5 * 60;
const ENRICH_STALE_SEC = 30 * 60;
const ENRICH_RUNNING_TTL_SEC = 30;
const PAGE_TTL_SEC = 60;
const PAGE_STALE_SEC = 10 * 60;

type CacheEnvelope<T> = {
  savedAt: number;
  freshUntil: number;
  staleUntil: number;
  value: T;
};

type MemoryEntry = { expiresAt: number; raw: string };

const memory = new Map<string, MemoryEntry>();
const inflight = new Map<string, Promise<unknown>>();

function memoryGet(key: string): string | null {
  const cur = memory.get(key);
  if (!cur) return null;
  if (cur.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return cur.raw;
}

function memorySet(key: string, raw: string, ttlSec: number): void {
  memory.set(key, { raw, expiresAt: Date.now() + ttlSec * 1000 });
}

async function cacheRead<T>(key: string): Promise<CacheEnvelope<T> | null> {
  const raw = memoryGet(key) ?? (await kvGet(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    memorySet(
      key,
      raw,
      Math.max(1, Math.ceil((parsed.staleUntil - Date.now()) / 1000)),
    );
    return parsed;
  } catch {
    return null;
  }
}

async function cacheWrite<T>(
  key: string,
  value: T,
  freshTtlSec: number,
  staleTtlSec: number,
): Promise<void> {
  const now = Date.now();
  const envelope: CacheEnvelope<T> = {
    savedAt: now,
    freshUntil: now + freshTtlSec * 1000,
    staleUntil: now + staleTtlSec * 1000,
    value,
  };
  const raw = JSON.stringify(envelope);
  memorySet(key, raw, staleTtlSec);
  await kvSet(key, raw, staleTtlSec);
}

function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/** Stable short fingerprint for an API key (never store the key itself). */
export function credentialFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

function agentsKey(fp: string): string {
  return `monitor:v3:agents:${fp}`;
}

function enrichKey(fp: string, agentId: string): string {
  return `monitor:v3:enrich:${fp}:${agentId}`;
}

function projectsPageKey(fp: string): string {
  return `monitor:v3:page:projects:${fp}`;
}

function projectDetailKey(fp: string, project: string, sort: string): string {
  const canonical =
    project === NO_REPO_GROUP ? project : normalizeRepoLabel(project);
  return `monitor:v3:page:project:${fp}:${encodeURIComponent(canonical)}:${sort}`;
}

export type AgentCatalog = {
  items: AgentSummary[];
  truncated: boolean;
  fromCache: boolean;
  stale: boolean;
};

async function fetchAgentCatalog(client: CursorClient): Promise<{
  items: AgentSummary[];
  truncated: boolean;
}> {
  return client.listAllAgents({ pageSize: 100, maxPages: 40 });
}

export async function getCachedAgentCatalog(
  client: CursorClient,
  fingerprint: string,
): Promise<AgentCatalog> {
  const key = agentsKey(fingerprint);
  const cached = await cacheRead<{ items: AgentSummary[]; truncated: boolean }>(
    key,
  );
  const now = Date.now();

  if (cached && now < cached.freshUntil) {
    return {
      items: cached.value.items,
      truncated: cached.value.truncated,
      fromCache: true,
      stale: false,
    };
  }

  if (cached && now < cached.staleUntil) {
    void singleflight(`refresh:${key}`, async () => {
      const fresh = await fetchAgentCatalog(client);
      await cacheWrite(key, fresh, AGENTS_TTL_SEC, AGENTS_STALE_SEC);
      return fresh;
    });
    return {
      items: cached.value.items,
      truncated: cached.value.truncated,
      fromCache: true,
      stale: true,
    };
  }

  const fresh = await singleflight(`load:${key}`, () => fetchAgentCatalog(client));
  await cacheWrite(key, fresh, AGENTS_TTL_SEC, AGENTS_STALE_SEC);
  return {
    items: fresh.items,
    truncated: fresh.truncated,
    fromCache: false,
    stale: false,
  };
}

function enrichTtlFor(agent: EnrichedAgent): number {
  const status = (agent.latestRunStatus ?? agent.status ?? '').toUpperCase();
  if (
    status === 'RUNNING' ||
    status === 'CREATING' ||
    status === 'PENDING' ||
    status === 'QUEUED'
  ) {
    return ENRICH_RUNNING_TTL_SEC;
  }
  return ENRICH_TTL_SEC;
}

export async function getCachedEnrichedAgents(
  client: CursorClient,
  fingerprint: string,
  agents: AgentSummary[],
  opts?: { concurrency?: number; limit?: number },
): Promise<{ agents: EnrichedAgent[]; truncatedEnrichment: boolean }> {
  const concurrency = opts?.concurrency ?? 16;
  const limit = opts?.limit ?? 80;
  const truncatedEnrichment = agents.length > limit;
  const slice = agents.slice(0, limit);

  const cachedById = new Map<string, EnrichedAgent>();
  const missing: AgentSummary[] = [];

  await Promise.all(
    slice.map(async (agent) => {
      const cached = await cacheRead<EnrichedAgent>(
        enrichKey(fingerprint, agent.id),
      );
      const now = Date.now();
      if (cached && now < cached.freshUntil) {
        cachedById.set(agent.id, { ...cached.value, ...pickLiveFields(agent) });
        return;
      }
      if (cached && now < cached.staleUntil) {
        cachedById.set(agent.id, { ...cached.value, ...pickLiveFields(agent) });
        void singleflight(`enrich:${agent.id}`, async () => {
          const { agents: [fresh] = [] } = await enrichAgentsWithPrAndCost(
            client,
            [agent],
            { concurrency: 1, limit: 1 },
          );
          if (fresh) {
            await cacheWrite(
              enrichKey(fingerprint, agent.id),
              fresh,
              enrichTtlFor(fresh),
              ENRICH_STALE_SEC,
            );
          }
          return fresh;
        });
        return;
      }
      missing.push(agent);
    }),
  );

  if (missing.length > 0) {
    const { agents: freshlyEnriched } = await enrichAgentsWithPrAndCost(
      client,
      missing,
      { concurrency, limit: missing.length },
    );
    await Promise.all(
      freshlyEnriched.map(async (agent) => {
        cachedById.set(agent.id, agent);
        await cacheWrite(
          enrichKey(fingerprint, agent.id),
          agent,
          enrichTtlFor(agent),
          ENRICH_STALE_SEC,
        );
      }),
    );
  }

  const enriched = slice.map((agent) => {
    const hit = cachedById.get(agent.id);
    if (hit) return hit;
    return emptyEnrichment(agent);
  });

  const rest = agents.slice(limit).map(emptyEnrichment);
  return { agents: [...enriched, ...rest], truncatedEnrichment };
}

function pickLiveFields(agent: AgentSummary): Partial<AgentSummary> {
  return {
    name: agent.name,
    status: agent.status,
    updatedAt: agent.updatedAt,
    latestRunId: agent.latestRunId,
    repos: agent.repos,
    url: agent.url,
    createdAt: agent.createdAt,
    source: agent.source,
    automationId: agent.automationId,
    automationName: agent.automationName,
  };
}

function emptyEnrichment(agent: AgentSummary): EnrichedAgent {
  return {
    ...agent,
    prs: [],
    branch: null,
    cost: {
      chargedSumCents: null,
      rawSumCents: null,
      providerChargedCents: null,
      providerRawCents: null,
      runCountWithCost: 0,
      runCount: 0,
    },
  };
}

export type MonitoringCredential = {
  client: CursorClient;
  fingerprint: string;
};

/** Merge agent catalogues from multiple org credentials (dedupe by agent id). */
export async function getMergedAgentCatalog(
  credentials: MonitoringCredential[],
): Promise<AgentCatalog> {
  if (credentials.length === 0) {
    return { items: [], truncated: false, fromCache: false, stale: false };
  }
  if (credentials.length === 1) {
    const only = credentials[0]!;
    return getCachedAgentCatalog(only.client, only.fingerprint);
  }

  const catalogs = await Promise.all(
    credentials.map((c) => getCachedAgentCatalog(c.client, c.fingerprint)),
  );
  const byId = new Map<string, AgentSummary>();
  let truncated = false;
  let fromCache = true;
  let stale = false;
  for (let i = 0; i < catalogs.length; i += 1) {
    const catalog = catalogs[i]!;
    const fp = credentials[i]!.fingerprint;
    truncated = truncated || catalog.truncated;
    fromCache = fromCache && catalog.fromCache;
    stale = stale || catalog.stale;
    for (const agent of catalog.items) {
      if (byId.has(agent.id)) continue;
      byId.set(agent.id, {
        ...agent,
        // Stash which credential owns this agent for later enrichment routing.
        credentialFingerprint: fp,
      } as AgentSummary & { credentialFingerprint?: string });
    }
  }
  return {
    items: [...byId.values()],
    truncated,
    fromCache,
    stale,
  };
}

/**
 * Enrich agents, routing each id to the credential that listed it when
 * multiple org keys are connected.
 */
export async function getCachedEnrichedAgentsMulti(
  credentials: MonitoringCredential[],
  agents: AgentSummary[],
  opts?: { concurrency?: number; limit?: number },
): Promise<{ agents: EnrichedAgent[]; truncatedEnrichment: boolean }> {
  if (credentials.length === 0) {
    return { agents: agents.map(emptyEnrichment), truncatedEnrichment: false };
  }
  if (credentials.length === 1) {
    const only = credentials[0]!;
    return getCachedEnrichedAgents(only.client, only.fingerprint, agents, opts);
  }

  const byFp = new Map<string, AgentSummary[]>();
  const fallbackFp = credentials[0]!.fingerprint;
  for (const agent of agents) {
    const tagged = agent as AgentSummary & { credentialFingerprint?: string };
    const fp = tagged.credentialFingerprint ?? fallbackFp;
    const list = byFp.get(fp) ?? [];
    list.push(agent);
    byFp.set(fp, list);
  }

  const credByFp = new Map(credentials.map((c) => [c.fingerprint, c]));
  const enrichedParts = await Promise.all(
    [...byFp.entries()].map(async ([fp, slice]) => {
      const cred = credByFp.get(fp) ?? credentials[0]!;
      const { agents: enriched, truncatedEnrichment } =
        await getCachedEnrichedAgents(cred.client, cred.fingerprint, slice, opts);
      return {
        agents: enriched.map((a) => ({
          ...a,
          credentialFingerprint: cred.fingerprint,
        })),
        truncatedEnrichment,
      };
    }),
  );

  const byId = new Map<string, EnrichedAgent>();
  let truncatedEnrichment = false;
  for (const part of enrichedParts) {
    truncatedEnrichment = truncatedEnrichment || part.truncatedEnrichment;
    for (const agent of part.agents) byId.set(agent.id, agent);
  }
  return {
    agents: agents.map((a) => byId.get(a.id) ?? emptyEnrichment(a)),
    truncatedEnrichment,
  };
}

async function withAutomationAttribution(
  agents: EnrichedAgent[],
): Promise<EnrichedAgent[]> {
  const attribution = await loadAutomationAttributionMap(createEnvAdminClient());
  return applyAutomationAttribution(agents, attribution);
}

export type ProjectsPagePayload = {
  projects: ProjectSummary[];
  agentCount: number;
  truncated: boolean;
  truncatedEnrichment: boolean;
  fromCache: boolean;
};

/**
 * Fully assembled Monitoring → Projects page payload, SWR-cached.
 * Repeat visits avoid both the catalogue crawl and enrichment fan-out.
 */
export async function getCachedProjectsPage(
  credentials: MonitoringCredential[],
): Promise<ProjectsPagePayload> {
  const creds = credentials;
  const combinedFp =
    creds.length === 1
      ? creds[0]!.fingerprint
      : createHash('sha256')
          .update(
            creds
              .map((c) => c.fingerprint)
              .sort()
              .join('|'),
          )
          .digest('hex')
          .slice(0, 24);

  const key = projectsPageKey(combinedFp);
  const cached = await cacheRead<Omit<ProjectsPagePayload, 'fromCache'>>(key);
  const now = Date.now();

  const load = async (): Promise<Omit<ProjectsPagePayload, 'fromCache'>> => {
    const catalog = await getMergedAgentCatalog(creds);
    const { agents: enrichedSlice, truncatedEnrichment } =
      await getCachedEnrichedAgentsMulti(creds, catalog.items, {
        concurrency: 16,
        limit: 80,
      });
    const attributed = await withAutomationAttribution(enrichedSlice);
    const byId = new Map(attributed.map((a) => [a.id, a]));
    const enriched: EnrichedAgent[] = catalog.items.map(
      (a) => byId.get(a.id) ?? emptyEnrichment(a),
    );
    const projects = sortProjectSummaries(
      groupEnrichedAgentsByRepo(enriched).map(summarizeProject),
    );

    // Seed per-project detail caches so the first click into a project
    // after Projects is a memory hit instead of another enrich pass.
    const byRepo = groupEnrichedAgentsByRepo(enriched);
    await Promise.all(
      byRepo.slice(0, 12).map(async (group) => {
        const detailKey = projectDetailKey(combinedFp, group.repo, 'cost');
        const existing = await cacheRead(detailKey);
        if (existing && Date.now() < existing.freshUntil) return;
        const sections = partitionProjectRuns(
          await attachPrTitlesOntoAgents(group.agents),
          'cost',
        );
        let repoUrl: string | null = null;
        for (const agent of group.agents) {
          for (const repo of agent.repos ?? []) {
            if (!repo.url) continue;
            if (agentRepoLabels([repo]).includes(group.repo)) {
              repoUrl = repo.url.includes('://')
                ? repo.url
                : `https://${repo.url}`;
              break;
            }
          }
          if (repoUrl) break;
          for (const pr of agent.prs) {
            if (
              agentRepoLabelsIncludingPrs({ prs: [pr] }).includes(group.repo)
            ) {
              repoUrl = `https://github.com/${group.repo}`;
              break;
            }
          }
          if (repoUrl) break;
        }
        await cacheWrite(
          detailKey,
          {
            sections,
            enrichedCount: group.agents.length,
            truncatedEnrichment: false,
            repoUrl,
          } satisfies Omit<ProjectDetailPayload, 'fromCache'>,
          PAGE_TTL_SEC,
          PAGE_STALE_SEC,
        );
      }),
    );

    return {
      projects,
      agentCount: catalog.items.length,
      truncated: catalog.truncated,
      truncatedEnrichment,
    };
  };

  if (cached && now < cached.freshUntil) {
    return { ...cached.value, fromCache: true };
  }
  if (cached && now < cached.staleUntil) {
    void singleflight(`refresh:${key}`, async () => {
      const fresh = await load();
      await cacheWrite(key, fresh, PAGE_TTL_SEC, PAGE_STALE_SEC);
      return fresh;
    });
    return { ...cached.value, fromCache: true };
  }

  const fresh = await singleflight(`load:${key}`, load);
  await cacheWrite(key, fresh, PAGE_TTL_SEC, PAGE_STALE_SEC);
  return { ...fresh, fromCache: false };
}

async function attachPrTitlesOntoAgents(
  agents: EnrichedAgent[],
): Promise<EnrichedAgent[]> {
  // Reuse attachGithubPrTitles by wrapping as PR groups briefly.
  const urls = agents.flatMap((a) => a.prs.map((p) => p.prUrl));
  if (urls.length === 0) return agents;
  const { resolveGithubPrTitles } = await import('./github-pr-titles');
  const titles = await resolveGithubPrTitles(urls);
  if (titles.size === 0) return agents;
  return agents.map((agent) => ({
    ...agent,
    prs: agent.prs.map((pr) => {
      const title = titles.get(pr.prUrl);
      return title ? { ...pr, title } : pr;
    }),
  }));
}

export type ProjectDetailPayload = {
  sections: ProjectRunSections;
  enrichedCount: number;
  truncatedEnrichment: boolean;
  repoUrl: string | null;
  fromCache: boolean;
};

export async function getCachedProjectDetail(
  credentials: MonitoringCredential[],
  project: string,
  sort: ConversationGroupSort = 'cost',
): Promise<ProjectDetailPayload | { empty: true; fromCache: boolean }> {
  const creds = credentials;
  const combinedFp =
    creds.length === 1
      ? creds[0]!.fingerprint
      : createHash('sha256')
          .update(
            creds
              .map((c) => c.fingerprint)
              .sort()
              .join('|'),
          )
          .digest('hex')
          .slice(0, 24);

  const cacheSort: ConversationGroupSort = 'cost';
  const key = projectDetailKey(combinedFp, project, cacheSort);
  const cached = await cacheRead<Omit<ProjectDetailPayload, 'fromCache'>>(key);
  const now = Date.now();

  const load = async (): Promise<
    Omit<ProjectDetailPayload, 'fromCache'> | { empty: true }
  > => {
    const catalog = await getMergedAgentCatalog(creds);
    // Enrich first so PR-derived repos are available for project membership.
    const { agents: enrichedAll, truncatedEnrichment } =
      await getCachedEnrichedAgentsMulti(creds, catalog.items, {
        concurrency: 16,
        limit: 120,
      });
    const attributed = await withAutomationAttribution(enrichedAll);
    const withTitles = await attachPrTitlesOntoAgents(attributed);
    const canonical =
      project === NO_REPO_GROUP ? project : normalizeRepoLabel(project);
    const inProject = withTitles.filter((agent) => {
      const labels = agentRepoLabelsIncludingPrs(agent);
      if (canonical === NO_REPO_GROUP) return labels.length === 0;
      return labels.includes(canonical);
    });
    if (inProject.length === 0) return { empty: true };

    const sections = partitionProjectRuns(inProject, cacheSort);
    let repoUrl: string | null = null;
    for (const agent of inProject) {
      for (const repo of agent.repos ?? []) {
        if (!repo.url) continue;
        if (agentRepoLabels([repo]).includes(canonical)) {
          repoUrl = repo.url.includes('://') ? repo.url : `https://${repo.url}`;
          break;
        }
      }
      if (repoUrl) break;
    }
    if (!repoUrl && canonical !== NO_REPO_GROUP) {
      repoUrl = `https://github.com/${canonical}`;
    }
    return {
      sections,
      enrichedCount: inProject.length,
      truncatedEnrichment,
      repoUrl,
    };
  };

  const resortCached = (
    value: Omit<ProjectDetailPayload, 'fromCache'>,
  ): ProjectDetailPayload => ({
    ...value,
    sections: partitionProjectRuns(
      [
        ...value.sections.automations.flatMap((a) => a.conversations),
        ...value.sections.userRequests,
      ],
      sort,
    ),
    fromCache: true,
  });

  if (cached && now < cached.freshUntil && cached.value.sections) {
    return resortCached(cached.value);
  }
  if (cached && now < cached.staleUntil && cached.value.sections) {
    void singleflight(`refresh:${key}`, async () => {
      const fresh = await load();
      if (!('empty' in fresh)) {
        await cacheWrite(key, fresh, PAGE_TTL_SEC, PAGE_STALE_SEC);
      }
      return fresh;
    });
    return resortCached(cached.value);
  }

  const fresh = await singleflight(`load:${key}`, load);
  if ('empty' in fresh) return { empty: true, fromCache: false };
  await cacheWrite(key, fresh, PAGE_TTL_SEC, PAGE_STALE_SEC);
  return {
    ...fresh,
    sections: partitionProjectRuns(
      [
        ...fresh.sections.automations.flatMap((a) => a.conversations),
        ...fresh.sections.userRequests,
      ],
      sort,
    ),
    fromCache: false,
  };
}

/** Drop cached monitoring data for a credential (e.g. after key rotate). */
export async function invalidateMonitoringCache(
  fingerprint: string,
): Promise<void> {
  const keys = [agentsKey(fingerprint), projectsPageKey(fingerprint)];
  for (const key of keys) {
    memory.delete(key);
    await kvSet(
      key,
      JSON.stringify({
        savedAt: 0,
        freshUntil: 0,
        staleUntil: 0,
        value: null,
      }),
      1,
    );
  }
}

/** Test helper. */
export function resetMonitoringMemoryCache(): void {
  memory.clear();
  inflight.clear();
}
