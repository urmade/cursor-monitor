import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { cache } from 'react';
import {
  createCursorClient,
  defaultCursorApiBaseUrl,
  type AgentSummary,
  type ApiKeyInfo,
  type CursorClient,
} from '@nexus/cursor-client';
import {
  automationDisplayName,
  automationMetaFromRun,
  NO_PR_GROUP,
  parseGithubPrRef,
  partitionProjectRunsByAutomation,
  sortConversationGroupsBy,
  type ConversationGroupSort,
} from '../lib/monitoring-format';
import type { StoredCursorOrganisation } from './cursor-org-store';

export {
  classifyRunStatus,
  runDidNotFinish,
  RUN_OUTCOME_LABELS,
  type RunOutcome,
} from '../lib/monitoring-status';
export {
  automationDisplayName,
  automationMetaFromRun,
  formatCentsUsd,
  formatHookCostUsd,
  formatRelativeTime,
  formatPrNumberLabel,
  NO_PR_GROUP,
  parseConversationGroupSort,
  parseGithubPrRef,
  partitionProjectRunsByAutomation,
  resolvePrDisplayName,
  type ConversationGroupSort,
  type GithubPrRef,
} from '../lib/monitoring-format';

/** httpOnly cookie holding user-pasted Cursor API keys (prototype BYOK). */
export const CURSOR_USER_API_KEY_COOKIE = 'nexus_cursor_user_api_key';
/** Multi-key cookie: JSON string array of API keys (different Cursor orgs). */
export const CURSOR_USER_API_KEYS_COOKIE = 'nexus_cursor_user_api_keys';

function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

/** Combined fingerprint for a set of credentials (stable cache key). */
export function combinedCredentialFingerprint(fingerprints: string[]): string {
  const sorted = [...fingerprints].filter(Boolean).sort();
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return sorted[0]!;
  return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 24);
}

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days
const MAX_STORED_API_KEYS = 8;

export type CursorCredentialSource = 'user_cookie' | 'env' | 'none';

export type ResolvedCursorCredential = {
  client: CursorClient;
  fingerprint: string;
  me: ApiKeyInfo | null;
  identityLabel: string;
  source: 'user_cookie' | 'env';
  /** Local organisation connection id when sourced from settings. */
  organisationConnectionId?: string;
  /** Public Cursor organization id (`org_…`) when configured. */
  organizationId?: string | null;
  /** Cursor API base URL used for this credential. */
  baseUrl?: string;
  /** Admin-chosen organisation label. */
  organisationLabel?: string;
};

export type ResolvedCursorAuth = {
  /** Primary client (first cookie key, else env) for simple single-client callers. */
  client: CursorClient | null;
  source: CursorCredentialSource;
  me: ApiKeyInfo | null;
  error: string | null;
  /** Fingerprint of the primary API key; null when unauthenticated. */
  fingerprint: string | null;
  /** Every usable credential (multiple org keys, or a single env fallback). */
  credentials: ResolvedCursorCredential[];
  /** Stable fingerprint spanning all credentials — use for monitoring caches. */
  combinedFingerprint: string | null;
};

function envCursorApiKey(): string | null {
  const key =
    process.env.CURSOR_API_KEY?.trim() ||
    process.env.CURSOR_SERVICE_ACCOUNT_KEY?.trim() ||
    '';
  return key || null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SEC,
  };
}

/** Parse stored keys from the multi-key cookie and legacy single-key cookie. */
export async function readUserCursorApiKeys(): Promise<string[]> {
  const store = await cookies();
  const multi = store.get(CURSOR_USER_API_KEYS_COOKIE)?.value?.trim();
  if (multi) {
    try {
      const parsed = JSON.parse(multi) as unknown;
      if (Array.isArray(parsed)) {
        return [
          ...new Set(
            parsed
              .map((k) => (typeof k === 'string' ? k.trim() : ''))
              .filter((k) => k.length >= 20),
          ),
        ].slice(0, MAX_STORED_API_KEYS);
      }
    } catch {
      // fall through to legacy
    }
  }
  const legacy = store.get(CURSOR_USER_API_KEY_COOKIE)?.value?.trim();
  return legacy ? [legacy] : [];
}

/** @deprecated Prefer readUserCursorApiKeys — returns the first stored key. */
export async function readUserCursorApiKey(): Promise<string | null> {
  const keys = await readUserCursorApiKeys();
  return keys[0] ?? null;
}

export async function writeUserCursorApiKeys(apiKeys: string[]): Promise<void> {
  const store = await cookies();
  const unique = [
    ...new Set(apiKeys.map((k) => k.trim()).filter((k) => k.length >= 20)),
  ].slice(0, MAX_STORED_API_KEYS);
  const opts = cookieOptions();
  if (unique.length === 0) {
    store.delete(CURSOR_USER_API_KEYS_COOKIE);
    store.delete(CURSOR_USER_API_KEY_COOKIE);
    return;
  }
  store.set(CURSOR_USER_API_KEYS_COOKIE, JSON.stringify(unique), opts);
  // Keep legacy cookie in sync for any older readers.
  store.set(CURSOR_USER_API_KEY_COOKIE, unique[0]!, opts);
}

/** Replace stored keys with a single key (backward-compatible helper). */
export async function writeUserCursorApiKey(apiKey: string): Promise<void> {
  await writeUserCursorApiKeys([apiKey]);
}

export async function clearUserCursorApiKey(): Promise<void> {
  await writeUserCursorApiKeys([]);
}

async function probeCredential(
  apiKey: string,
  source: 'user_cookie' | 'env',
  opts?: {
    baseUrl?: string;
    organisation?: StoredCursorOrganisation;
  },
): Promise<ResolvedCursorCredential | { error: string }> {
  const baseUrl = opts?.baseUrl ?? defaultCursorApiBaseUrl();
  const client = createCursorClient({ apiKey, baseUrl });
  const fingerprint = fingerprintApiKey(apiKey);
  try {
    const me = await client.getMe();
    const identity = formatApiKeyIdentity(me);
    const orgLabel = opts?.organisation?.label?.trim();
    const orgId = opts?.organisation?.organizationId;
    const identityLabel = orgLabel
      ? `${orgLabel}${orgId ? ` · ${orgId}` : ''} · ${identity}`
      : identity;
    return {
      client,
      fingerprint,
      me,
      identityLabel,
      source,
      organisationConnectionId: opts?.organisation?.id,
      organizationId: orgId ?? null,
      baseUrl,
      organisationLabel: orgLabel,
    };
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `Cursor API key failed (/v1/me): ${err.message}`
          : 'Cursor API key failed (/v1/me)',
    };
  }
}

/** Prefer configured organisations; fall back to env service-account / shared key. */
async function resolveCursorAuthUncached(): Promise<ResolvedCursorAuth> {
  // Lazy import avoids a circular init with cursor-org-store ↔ cursor.
  const { readCursorOrganisations } = await import('./cursor-org-store');
  const organisations = await readCursorOrganisations();
  if (organisations.length > 0) {
    const results = await Promise.all(
      organisations.map((org) =>
        probeCredential(org.apiKey, 'user_cookie', {
          baseUrl: org.baseUrl,
          organisation: org,
        }),
      ),
    );
    const credentials: ResolvedCursorCredential[] = [];
    const errors: string[] = [];
    for (const result of results) {
      if ('error' in result) errors.push(result.error);
      else credentials.push(result);
    }
    if (credentials.length === 0) {
      return {
        client: null,
        source: 'user_cookie',
        me: null,
        fingerprint: null,
        credentials: [],
        combinedFingerprint: null,
        error: errors[0] ?? 'Saved Cursor API key failed (/v1/me)',
      };
    }
    const primary = credentials[0]!;
    return {
      client: primary.client,
      source: 'user_cookie',
      me: primary.me,
      fingerprint: primary.fingerprint,
      credentials,
      combinedFingerprint: combinedCredentialFingerprint(
        credentials.map((c) => c.fingerprint),
      ),
      error: errors.length > 0 ? errors.join(' · ') : null,
    };
  }

  const envKey = envCursorApiKey();
  if (!envKey) {
    return {
      client: null,
      source: 'none',
      me: null,
      error: null,
      fingerprint: null,
      credentials: [],
      combinedFingerprint: null,
    };
  }

  const probed = await probeCredential(envKey, 'env');
  if ('error' in probed) {
    return {
      client: null,
      source: 'env',
      me: null,
      fingerprint: null,
      credentials: [],
      combinedFingerprint: null,
      error: probed.error.replace('Cursor API key', 'Env Cursor API key'),
    };
  }
  return {
    client: probed.client,
    source: 'env',
    me: probed.me,
    fingerprint: probed.fingerprint,
    credentials: [probed],
    combinedFingerprint: probed.fingerprint,
    error: null,
  };
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

/**
 * Normalize a repository label for grouping / matching.
 * GitHub owner and repo names are case-insensitive; lowercasing merges
 * variants like `nexus` and `Nexus` into one monitoring project.
 */
export function normalizeRepoLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function agentRepoLabels(
  repos: Array<{ url?: string } | string> | null | undefined,
): string[] {
  if (!repos?.length) return [];
  const labels = repos
    .map((r) => {
      const url = typeof r === 'string' ? r : r.url;
      if (!url) return null;
      try {
        const u = new URL(url.includes('://') ? url : `https://${url}`);
        const label =
          u.pathname.replace(/^\//, '').replace(/\.git$/, '') || u.host;
        return normalizeRepoLabel(label);
      } catch {
        return normalizeRepoLabel(url);
      }
    })
    .filter((x): x is string => Boolean(x));
  return [...new Set(labels)];
}

/** Repo labels from agent.repos plus owner/repo derived from linked PRs. */
export function agentRepoLabelsIncludingPrs(
  agent: {
    repos?: Array<{ url?: string }> | null;
    prs?: Array<{ prUrl?: string }>;
  },
): string[] {
  const fromRepos = agentRepoLabels(agent.repos);
  const fromPrs: string[] = [];
  for (const pr of agent.prs ?? []) {
    const ref = parseGithubPrRef(pr.prUrl);
    if (ref) fromPrs.push(normalizeRepoLabel(`${ref.owner}/${ref.repo}`));
  }
  return [...new Set([...fromRepos, ...fromPrs])];
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
 * Group agents by repo label (lowercased). Multi-repo agents appear in each
 * matching group. Case variants of the same repo (e.g. `Nexus` / `nexus`)
 * share one group. Agents with no repos go under {@link NO_REPO_GROUP}.
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
  /** Credential fingerprint that could fetch this agent (multi-key). */
  credentialFingerprint?: string;
};

/** Read automation attribution from agent payload fields when present. */
export function automationMetaFromAgent(agent: {
  source?: string;
  automationId?: string;
  automationName?: string;
  [key: string]: unknown;
}): { automationId: string; automationName: string | null } | null {
  return automationMetaFromRun(agent);
}

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

export type AutomationRunGroup = {
  automationId: string;
  automationName: string;
  conversations: EnrichedAgent[];
  totalChargedCents: number | null;
  totalRawCents: number | null;
  latestCreatedAt: string | null;
};

export type ProjectRunSections = {
  automations: AutomationRunGroup[];
  userRequests: EnrichedAgent[];
  userRequestsTotalChargedCents: number | null;
  userRequestsLatestCreatedAt: string | null;
};

/**
 * Split enriched conversations into Automations (grouped by automationId) and
 * User requests. Sorting is applied within each bucket.
 */
export function partitionProjectRuns(
  agents: EnrichedAgent[],
  sort: ConversationGroupSort = 'cost',
): ProjectRunSections {
  const rows = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.latestRunStatus ?? agent.status,
    createdAt: agent.createdAt,
    source: agent.source,
    automationId: agent.automationId,
    automationName: agent.automationName,
    chargedCents: preferredChargedCents(agent),
    agent,
  }));
  const buckets = partitionProjectRunsByAutomation(rows, sort);
  const userAgents = buckets.userRequests.map((r) => r.agent);
  let userCharged: number | null = null;
  let userLatest: string | null = null;
  let userLatestMs = 0;
  for (const agent of userAgents) {
    const cc = preferredChargedCents(agent);
    if (cc != null) userCharged = (userCharged ?? 0) + cc;
    const createdMs = agent.createdAt ? Date.parse(agent.createdAt) : 0;
    if (createdMs > userLatestMs) {
      userLatestMs = createdMs;
      userLatest = agent.createdAt ?? null;
    }
  }

  return {
    automations: buckets.automations.map((g) => {
      const conversations = g.conversations.map((r) => r.agent);
      let raw: number | null = null;
      for (const c of conversations) {
        const rc = preferredRawCents(c);
        if (rc != null) raw = (raw ?? 0) + rc;
      }
      return {
        automationId: g.automationId,
        automationName: g.automationName,
        conversations,
        totalChargedCents: g.totalChargedCents,
        totalRawCents: raw,
        latestCreatedAt: g.latestCreatedAt,
      };
    }),
    userRequests: userAgents,
    userRequestsTotalChargedCents: userCharged,
    userRequestsLatestCreatedAt: userLatest,
  };
}

/**
 * Group enriched agents by repository, including repos inferred from PR URLs
 * so automation runs that only expose a PR still land under that project.
 */
export function groupEnrichedAgentsByRepo(
  agents: EnrichedAgent[],
): AgentRepoGroup<EnrichedAgent>[] {
  const map = new Map<string, EnrichedAgent[]>();

  for (const agent of agents) {
    const labels = agentRepoLabelsIncludingPrs(agent);
    const keys = labels.length > 0 ? labels : [NO_REPO_GROUP];
    for (const key of keys) {
      const list = map.get(key);
      if (list) list.push(agent);
      else map.set(key, [agent]);
    }
  }

  const sortAgents = (list: EnrichedAgent[]) =>
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
