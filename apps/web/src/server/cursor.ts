import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { cache } from 'react';
import {
  createCursorClient,
  type AgentSummary,
  type ApiKeyInfo,
  type CursorClient,
} from '@nexus/cursor-client';
import {
  NO_PR_GROUP,
  sortConversationGroupsBy,
  type ConversationGroupSort,
} from '../lib/monitoring-format';

export {
  classifyRunStatus,
  runDidNotFinish,
  RUN_OUTCOME_LABELS,
  type RunOutcome,
} from '../lib/monitoring-status';
export {
  formatCentsUsd,
  formatRelativeTime,
  formatPrNumberLabel,
  NO_PR_GROUP,
  parseConversationGroupSort,
  parseGithubPrRef,
  resolvePrDisplayName,
  type ConversationGroupSort,
  type GithubPrRef,
} from '../lib/monitoring-format';

/** httpOnly cookie holding a user-pasted Cursor API key (prototype BYOK). */
export const CURSOR_USER_API_KEY_COOKIE = 'nexus_cursor_user_api_key';

function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days

export type CursorCredentialSource = 'user_cookie' | 'env' | 'none';

export type ResolvedCursorAuth = {
  client: CursorClient | null;
  source: CursorCredentialSource;
  me: ApiKeyInfo | null;
  error: string | null;
  /** SHA-256 fingerprint of the API key in use (for cache keys); null when unauthenticated. */
  fingerprint: string | null;
};

function envCursorApiKey(): string | null {
  const key =
    process.env.CURSOR_API_KEY?.trim() ||
    process.env.CURSOR_SERVICE_ACCOUNT_KEY?.trim() ||
    '';
  return key || null;
}

export async function readUserCursorApiKey(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CURSOR_USER_API_KEY_COOKIE)?.value?.trim();
  return value || null;
}

export async function writeUserCursorApiKey(apiKey: string): Promise<void> {
  const store = await cookies();
  store.set(CURSOR_USER_API_KEY_COOKIE, apiKey, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SEC,
  });
}

export async function clearUserCursorApiKey(): Promise<void> {
  const store = await cookies();
  store.delete(CURSOR_USER_API_KEY_COOKIE);
}

/** Prefer personal cookie key; fall back to env service-account / shared key. */
async function resolveCursorAuthUncached(): Promise<ResolvedCursorAuth> {
  const userKey = await readUserCursorApiKey();
  if (userKey) {
    const client = createCursorClient({ apiKey: userKey });
    const fingerprint = fingerprintApiKey(userKey);
    try {
      const me = await client.getMe();
      return { client, source: 'user_cookie', me, error: null, fingerprint };
    } catch (err) {
      return {
        client: null,
        source: 'user_cookie',
        me: null,
        fingerprint: null,
        error:
          err instanceof Error
            ? `Saved Cursor API key failed (/v1/me): ${err.message}`
            : 'Saved Cursor API key failed (/v1/me)',
      };
    }
  }

  const envKey = envCursorApiKey();
  if (!envKey) {
    return { client: null, source: 'none', me: null, error: null, fingerprint: null };
  }

  const client = createCursorClient({ apiKey: envKey });
  const fingerprint = fingerprintApiKey(envKey);
  try {
    const me = await client.getMe();
    return { client, source: 'env', me, error: null, fingerprint };
  } catch (err) {
    return {
      client: null,
      source: 'env',
      me: null,
      fingerprint: null,
      error:
        err instanceof Error
          ? `Env Cursor API key failed (/v1/me): ${err.message}`
          : 'Env Cursor API key failed (/v1/me)',
    };
  }
}

/** Deduped per React request — layouts + pages share one auth resolve. */
export const resolveCursorAuth: () => Promise<ResolvedCursorAuth> = cache(
  resolveCursorAuthUncached,
);

/** @deprecated Prefer resolveCursorAuth — kept for simple callers. */
export function getCursorApiKey(): string | null {
  return envCursorApiKey();
}

export function createAppCursorClient(): CursorClient | null {
  const apiKey = envCursorApiKey();
  if (!apiKey) return null;
  return createCursorClient({ apiKey });
}

export function formatApiKeyIdentity(me: ApiKeyInfo | null): string {
  if (!me) return 'unknown';
  const nameParts = [me.userFirstName, me.userLastName].filter(Boolean);
  const person = nameParts.length
    ? nameParts.join(' ')
    : me.userEmail
      ? me.userEmail
      : null;
  const keyName = me.apiKeyName ?? 'API key';
  if (person) return `${person} · ${keyName}`;
  return `${keyName} (service account / team key)`;
}

export function agentRepoLabels(
  repos: Array<{ url?: string } | string> | null | undefined,
): string[] {
  if (!repos?.length) return [];
  return repos
    .map((r) => {
      const url = typeof r === 'string' ? r : r.url;
      if (!url) return null;
      try {
        const u = new URL(url.includes('://') ? url : `https://${url}`);
        return u.pathname.replace(/^\//, '').replace(/\.git$/, '') || u.host;
      } catch {
        return url;
      }
    })
    .filter((x): x is string => Boolean(x));
}

export function agentMatchesRepoFilter(
  agent: { name?: string; repos?: Array<{ url?: string }> },
  filter: string,
): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  const name = (agent.name ?? '').toLowerCase();
  if (name.includes(q)) return true;
  for (const label of agentRepoLabels(agent.repos)) {
    if (label.toLowerCase().includes(q)) return true;
  }
  for (const r of agent.repos ?? []) {
    if ((r.url ?? '').toLowerCase().includes(q)) return true;
  }
  return false;
}

export const NO_REPO_GROUP = 'No repository';

export type AgentRepoGroup<T> = {
  repo: string;
  agents: T[];
};

/**
 * Group agents by repo label. Multi-repo agents appear in each matching group.
 * Agents with no repos go under {@link NO_REPO_GROUP}.
 */
export function groupAgentsByRepo<
  T extends { name?: string; repos?: Array<{ url?: string }>; createdAt?: string },
>(agents: T[]): AgentRepoGroup<T>[] {
  const map = new Map<string, T[]>();

  for (const agent of agents) {
    const labels = agentRepoLabels(agent.repos);
    const keys = labels.length > 0 ? labels : [NO_REPO_GROUP];
    for (const key of keys) {
      const list = map.get(key);
      if (list) list.push(agent);
      else map.set(key, [agent]);
    }
  }

  const sortAgents = (list: T[]) =>
    [...list].sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bt - at;
    });

  const named = [...map.keys()]
    .filter((k) => k !== NO_REPO_GROUP)
    .sort((a, b) => a.localeCompare(b));
  const ordered = map.has(NO_REPO_GROUP) ? [...named, NO_REPO_GROUP] : named;

  return ordered.map((repo) => ({
    repo,
    agents: sortAgents(map.get(repo) ?? []),
  }));
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

const TERMINAL_RUN_STATUSES = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'];

/**
 * Wall-clock span of a run: createdAt → updatedAt for terminal runs,
 * createdAt → now while still running. The provider's own `durationMs`
 * is intentionally not used — live data shows it can be far shorter than
 * the actual run window on long agents (e.g. ~5m vs ~10h).
 */
export function runWallClockMs(
  run: {
    status?: string;
    createdAt?: string;
    updatedAt?: string;
  },
  nowMs: number = Date.now(),
): number | null {
  if (!run.createdAt) return null;
  const start = Date.parse(run.createdAt);
  if (!Number.isFinite(start)) return null;

  const terminal = TERMINAL_RUN_STATUSES.includes(
    (run.status ?? '').toUpperCase(),
  );
  let end: number | null = null;
  if (run.updatedAt) {
    const u = Date.parse(run.updatedAt);
    if (Number.isFinite(u)) end = u;
  }
  if (!terminal || end == null) {
    end = nowMs;
  }
  return end >= start ? end - start : null;
}

/**
 * Format provider cents (may be fractional) as USD. Sub-dollar amounts keep
 * up to 4 decimals so small run costs stay meaningful; larger amounts round
 * to cents.
 */
// formatCentsUsd / formatRelativeTime / classifyRunStatus re-exported from lib

export type AgentPrLink = {
  prUrl: string;
  label: string;
  /** GitHub PR title when resolved; optional. */
  title?: string | null;
  branch?: string;
  repoUrl?: string;
};

export type AgentCostAggregate = {
  /** Sum of per-run chargedCents from usage.runs[]. */
  chargedSumCents: number | null;
  /** Sum of per-run rawCostCents from usage.runs[]. */
  rawSumCents: number | null;
  /** Provider agent-level total when present. */
  providerChargedCents: number | null;
  providerRawCents: number | null;
  runCountWithCost: number;
  runCount: number;
};

export type EnrichedAgent = AgentSummary & {
  prs: AgentPrLink[];
  cost: AgentCostAggregate;
  /**
   * Status of the newest run (from listRuns), when enrichment fetched it.
   * Prefer this over agent-level `status` — v1 agents stay `ACTIVE` forever.
   */
  latestRunStatus?: string;
  enrichError?: string;
};

/** Prefer latest-run status when enrichment populated it; else agent status. */
export function conversationDisplayStatus(
  agent: Pick<EnrichedAgent, 'status' | 'latestRunStatus'>,
): string | undefined {
  return agent.latestRunStatus ?? agent.status;
}

/** Extract unique PR links from a run (or agent-level) git.branches snapshot. */
export function extractPrLinksFromGit(
  git:
    | { branches?: Array<{ prUrl?: string; branch?: string; repoUrl?: string }> }
    | null
    | undefined,
): AgentPrLink[] {
  const branches = git?.branches ?? [];
  const seen = new Set<string>();
  const out: AgentPrLink[] = [];
  for (const b of branches) {
    const prUrl = b.prUrl?.trim();
    if (!prUrl || seen.has(prUrl)) continue;
    seen.add(prUrl);
    out.push({
      prUrl,
      label: formatPrLabel(prUrl),
      branch: b.branch,
      repoUrl: b.repoUrl,
    });
  }
  return out;
}

export function formatPrLabel(prUrl: string): string {
  try {
    const u = new URL(prUrl.includes('://') ? prUrl : `https://${prUrl}`);
    const m = u.pathname.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (m) return `${m[1]}/${m[2]}#${m[3]}`;
    return u.pathname.replace(/^\//, '') || prUrl;
  } catch {
    return prUrl;
  }
}

/** Sum per-run costs from a normalised AgentUsage payload. */
export function aggregateUsageCost(
  usage: {
    chargedCents?: number;
    rawCostCents?: number;
    runs?: Array<{
      id?: string;
      cost?: { chargedCents?: number; rawCostCents?: number };
    }>;
  } | null | undefined,
  runCount = 0,
): AgentCostAggregate {
  const runs = usage?.runs ?? [];
  let chargedSum = 0;
  let rawSum = 0;
  let chargedN = 0;
  let rawN = 0;
  for (const r of runs) {
    if (typeof r.cost?.chargedCents === 'number') {
      chargedSum += r.cost.chargedCents;
      chargedN += 1;
    }
    if (typeof r.cost?.rawCostCents === 'number') {
      rawSum += r.cost.rawCostCents;
      rawN += 1;
    }
  }
  return {
    chargedSumCents: chargedN > 0 ? chargedSum : null,
    rawSumCents: rawN > 0 ? rawSum : null,
    providerChargedCents:
      typeof usage?.chargedCents === 'number' ? usage.chargedCents : null,
    providerRawCents:
      typeof usage?.rawCostCents === 'number' ? usage.rawCostCents : null,
    runCountWithCost: Math.max(chargedN, rawN),
    runCount: runCount || runs.length,
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length || 1) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Attach PR links (from run git.branches) and aggregated cost
 * (sum of usage.runs[].cost) for each agent. Bounded concurrency + optional limit.
 */
export async function enrichAgentsWithPrAndCost(
  client: CursorClient,
  agents: AgentSummary[],
  opts?: { concurrency?: number; limit?: number },
): Promise<{ agents: EnrichedAgent[]; truncatedEnrichment: boolean }> {
  // Higher default concurrency — Cursor handles ~16 parallel GETs fine and
  // this is the dominant cost after the agents catalogue itself.
  const concurrency = opts?.concurrency ?? 16;
  const limit = opts?.limit ?? 80;
  const truncatedEnrichment = agents.length > limit;
  const slice = agents.slice(0, limit);

  const enriched = await mapPool(slice, concurrency, async (agent) => {
    try {
      // listRuns limit=5 is enough for newest-run status + PR git snapshot;
      // getUsage carries the cost rollup. Skip the extra getRun round-trip.
      const [usage, runsPage] = await Promise.all([
        client.getUsage(agent.id).catch(() => null),
        client.listRuns(agent.id, { limit: 5 }).catch(() => null),
      ]);
      const runs = runsPage?.items ?? [];
      const withGit = [...runs].sort((a, b) => {
        const at = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
        return bt - at;
      });
      const latestRunStatus = withGit[0]?.status;
      let prs: AgentPrLink[] = [];
      for (const run of withGit) {
        prs = extractPrLinksFromGit(run.git);
        if (prs.length) break;
      }
      return {
        ...agent,
        prs,
        latestRunStatus,
        cost: aggregateUsageCost(usage, runs.length || usage?.runs?.length || 0),
      } satisfies EnrichedAgent;
    } catch (err) {
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
        enrichError: err instanceof Error ? err.message : String(err),
      } satisfies EnrichedAgent;
    }
  });

  const rest: EnrichedAgent[] = agents.slice(limit).map((agent) => ({
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
  }));

  return { agents: [...enriched, ...rest], truncatedEnrichment };
}

/** Best available charged-cost figure for a conversation (Σ runs, else provider total). */
export function preferredChargedCents(
  agent: Pick<EnrichedAgent, 'cost'>,
): number | null {
  return agent.cost.chargedSumCents ?? agent.cost.providerChargedCents;
}

/** Best available raw-cost figure for a conversation (Σ runs, else provider total). */
export function preferredRawCents(
  agent: Pick<EnrichedAgent, 'cost'>,
): number | null {
  return agent.cost.rawSumCents ?? agent.cost.providerRawCents;
}

/** Key for the bucket of conversations that do not target any pull request. */
// NO_PR_GROUP re-exported from lib/monitoring-format

export type ConversationPrGroup = {
  /** prUrl, or {@link NO_PR_GROUP}. */
  key: string;
  pr: AgentPrLink | null;
  conversations: EnrichedAgent[];
  /** Σ preferred charged cost across conversations; null when unknown. */
  totalChargedCents: number | null;
  totalRawCents: number | null;
  /** Newest conversation createdAt in the group (ISO), for "created" sorting. */
  latestCreatedAt: string | null;
};

/**
 * Group conversations by the pull request they target. A conversation that
 * targets several PRs appears in each of those groups; conversations with no
 * PR land in {@link NO_PR_GROUP}. Conversations inside a group are newest first.
 */
export function groupConversationsByPr(
  agents: EnrichedAgent[],
): ConversationPrGroup[] {
  const byKey = new Map<string, EnrichedAgent[]>();
  const prByKey = new Map<string, AgentPrLink>();

  for (const agent of agents) {
    if (agent.prs.length === 0) {
      const list = byKey.get(NO_PR_GROUP);
      if (list) list.push(agent);
      else byKey.set(NO_PR_GROUP, [agent]);
      continue;
    }
    for (const pr of agent.prs) {
      const list = byKey.get(pr.prUrl);
      if (list) list.push(agent);
      else byKey.set(pr.prUrl, [agent]);
      if (!prByKey.has(pr.prUrl)) prByKey.set(pr.prUrl, pr);
    }
  }

  return [...byKey.entries()].map(([key, conversations]) => {
    const sorted = [...conversations].sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bt - at;
    });
    let charged: number | null = null;
    let raw: number | null = null;
    for (const c of sorted) {
      const cc = preferredChargedCents(c);
      if (cc != null) charged = (charged ?? 0) + cc;
      const rc = preferredRawCents(c);
      if (rc != null) raw = (raw ?? 0) + rc;
    }
    return {
      key,
      pr: prByKey.get(key) ?? null,
      conversations: sorted,
      totalChargedCents: charged,
      totalRawCents: raw,
      latestCreatedAt: sorted[0]?.createdAt ?? null,
    };
  });
}

/**
 * Attach GitHub PR titles onto conversation groups when the API can resolve
 * them. Groups without a resolvable title keep `pr.title` unset so the UI can
 * fall back to the oldest conversation name / `#N`.
 */
export async function attachGithubPrTitles(
  groups: ConversationPrGroup[],
  resolveTitles: (
    prUrls: Iterable<string>,
  ) => Promise<Map<string, string>> = defaultResolveGithubPrTitles,
): Promise<ConversationPrGroup[]> {
  const urls = groups
    .map((g) => g.pr?.prUrl)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (urls.length === 0) return groups;

  const titles = await resolveTitles(urls);
  if (titles.size === 0) return groups;

  return groups.map((g) => {
    if (!g.pr) return g;
    const title = titles.get(g.pr.prUrl);
    if (!title) return g;
    return { ...g, pr: { ...g.pr, title } };
  });
}

async function defaultResolveGithubPrTitles(
  prUrls: Iterable<string>,
): Promise<Map<string, string>> {
  const { resolveGithubPrTitles } = await import('./github-pr-titles');
  return resolveGithubPrTitles(prUrls);
}

/**
 * Order groups for display: by total charged cost or by newest conversation,
 * descending. The no-PR bucket always sorts last.
 */
export function sortConversationGroups(
  groups: ConversationPrGroup[],
  sort: ConversationGroupSort,
): ConversationPrGroup[] {
  return sortConversationGroupsBy(groups, sort);
}

export type ProjectSummary = {
  /** Repository label, e.g. `internalsphere/nexus`, or {@link NO_REPO_GROUP}. */
  repo: string;
  conversationCount: number;
  /** Unique pull requests targeted by conversations in this project. */
  prCount: number;
  totalChargedCents: number | null;
  totalRawCents: number | null;
  latestCreatedAt: string | null;
};

export function summarizeProject(
  group: AgentRepoGroup<EnrichedAgent>,
): ProjectSummary {
  const prUrls = new Set<string>();
  let charged: number | null = null;
  let raw: number | null = null;
  let latest: string | null = null;
  let latestMs = 0;

  for (const agent of group.agents) {
    for (const pr of agent.prs) prUrls.add(pr.prUrl);
    const cc = preferredChargedCents(agent);
    if (cc != null) charged = (charged ?? 0) + cc;
    const rc = preferredRawCents(agent);
    if (rc != null) raw = (raw ?? 0) + rc;
    const createdMs = agent.createdAt ? Date.parse(agent.createdAt) : 0;
    if (createdMs > latestMs) {
      latestMs = createdMs;
      latest = agent.createdAt ?? null;
    }
  }

  return {
    repo: group.repo,
    conversationCount: group.agents.length,
    prCount: prUrls.size,
    totalChargedCents: charged,
    totalRawCents: raw,
    latestCreatedAt: latest,
  };
}

/** Order project summaries by newest conversation, no-repo pseudo-project last. */
export function sortProjectSummaries(summaries: ProjectSummary[]): ProjectSummary[] {
  const noRepo = summaries.filter((s) => s.repo === NO_REPO_GROUP);
  const rest = summaries.filter((s) => s.repo !== NO_REPO_GROUP);
  rest.sort((a, b) => {
    const at = a.latestCreatedAt ? Date.parse(a.latestCreatedAt) : 0;
    const bt = b.latestCreatedAt ? Date.parse(b.latestCreatedAt) : 0;
    if (at !== bt) return bt - at;
    return a.repo.localeCompare(b.repo);
  });
  return [...rest, ...noRepo];
}
