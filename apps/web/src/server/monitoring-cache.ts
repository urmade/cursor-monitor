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
  agentRepoLabels,
  enrichAgentsWithPrAndCost,
  groupAgentsByRepo,
  groupConversationsByPr,
  sortConversationGroups,
  sortProjectSummaries,
  summarizeProject,
  type ConversationGroupSort,
  type ConversationPrGroup,
  type EnrichedAgent,
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
  return `monitor:v1:agents:${fp}`;
}

function enrichKey(fp: string, agentId: string): string {
  return `monitor:v1:enrich:${fp}:${agentId}`;
}

function projectsPageKey(fp: string): string {
  return `monitor:v1:page:projects:${fp}`;
}

function projectDetailKey(fp: string, project: string, sort: string): string {
  return `monitor:v1:page:project:${fp}:${encodeURIComponent(project)}:${sort}`;
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
  };
}

function emptyEnrichment(agent: AgentSummary): EnrichedAgent {
  return {
    ...agent,
    prs: [],
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
  client: CursorClient,
  fingerprint: string,
): Promise<ProjectsPagePayload> {
  const key = projectsPageKey(fingerprint);
  const cached = await cacheRead<Omit<ProjectsPagePayload, 'fromCache'>>(key);
  const now = Date.now();

  const load = async (): Promise<Omit<ProjectsPagePayload, 'fromCache'>> => {
    const catalog = await getCachedAgentCatalog(client, fingerprint);
    const targets = catalog.items
      .filter((a) => (a.repos?.length ?? 0) > 0)
      .sort((a, b) => {
        const at = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
        return bt - at;
      });
    const { agents: enrichedSlice, truncatedEnrichment } =
      await getCachedEnrichedAgents(client, fingerprint, targets, {
        concurrency: 16,
        limit: 60,
      });
    const byId = new Map(enrichedSlice.map((a) => [a.id, a]));
    const enriched: EnrichedAgent[] = catalog.items.map(
      (a) => byId.get(a.id) ?? emptyEnrichment(a),
    );
    const projects = sortProjectSummaries(
      groupAgentsByRepo(enriched).map(summarizeProject),
    );

    // Seed per-project detail caches so the first click into a project
    // after Projects is a memory hit instead of another enrich pass.
    const byRepo = groupAgentsByRepo(enriched);
    await Promise.all(
      byRepo.slice(0, 12).map(async (group) => {
        const detailKey = projectDetailKey(fingerprint, group.repo, 'cost');
        const existing = await cacheRead(detailKey);
        if (existing && Date.now() < existing.freshUntil) return;
        const groups = sortConversationGroups(
          groupConversationsByPr(group.agents),
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
        }
        await cacheWrite(
          detailKey,
          {
            groups,
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

export type ProjectDetailPayload = {
  groups: ConversationPrGroup[];
  enrichedCount: number;
  truncatedEnrichment: boolean;
  repoUrl: string | null;
  fromCache: boolean;
};

export async function getCachedProjectDetail(
  client: CursorClient,
  fingerprint: string,
  project: string,
  sort: ConversationGroupSort,
  helpers: {
    agentsForProject: (
      agents: AgentSummary[],
      project: string,
    ) => AgentSummary[];
    findRepoUrl: (agents: AgentSummary[], project: string) => string | null;
  },
): Promise<ProjectDetailPayload | { empty: true; fromCache: boolean }> {
  // Sort is client-side now; always cache under the default 'cost' key and
  // let the client re-order. Keeps detail loads shareable across sort toggles.
  const cacheSort: ConversationGroupSort = 'cost';
  const key = projectDetailKey(fingerprint, project, cacheSort);
  const cached = await cacheRead<Omit<ProjectDetailPayload, 'fromCache'>>(key);
  const now = Date.now();

  const load = async (): Promise<
    Omit<ProjectDetailPayload, 'fromCache'> | { empty: true }
  > => {
    const catalog = await getCachedAgentCatalog(client, fingerprint);
    const inProject = helpers.agentsForProject(catalog.items, project);
    if (inProject.length === 0) return { empty: true };
    const { agents: enriched, truncatedEnrichment } =
      await getCachedEnrichedAgents(client, fingerprint, inProject, {
        concurrency: 16,
        limit: 100,
      });
    const groups = sortConversationGroups(
      groupConversationsByPr(enriched),
      cacheSort,
    );
    return {
      groups,
      enrichedCount: enriched.length,
      truncatedEnrichment,
      repoUrl: helpers.findRepoUrl(inProject, project),
    };
  };

  if (cached && now < cached.freshUntil) {
    return {
      ...cached.value,
      groups: sortConversationGroups(cached.value.groups, sort),
      fromCache: true,
    };
  }
  if (cached && now < cached.staleUntil) {
    void singleflight(`refresh:${key}`, async () => {
      const fresh = await load();
      if (!('empty' in fresh)) {
        await cacheWrite(key, fresh, PAGE_TTL_SEC, PAGE_STALE_SEC);
      }
      return fresh;
    });
    return {
      ...cached.value,
      groups: sortConversationGroups(cached.value.groups, sort),
      fromCache: true,
    };
  }

  const fresh = await singleflight(`load:${key}`, load);
  if ('empty' in fresh) return { empty: true, fromCache: false };
  await cacheWrite(key, fresh, PAGE_TTL_SEC, PAGE_STALE_SEC);
  return {
    ...fresh,
    groups: sortConversationGroups(fresh.groups, sort),
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
