/**
 * Client-safe formatting + group-sort helpers for monitoring UI.
 */

export type ConversationGroupSort = 'cost' | 'created';

export function parseConversationGroupSort(
  value: string | null | undefined,
): ConversationGroupSort {
  return value === 'created' ? 'created' : 'cost';
}

export function formatCentsUsd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  const subDollar = Math.abs(dollars) < 1;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: subDollar ? 4 : 2,
  }).format(dollars);
}

export function formatRelativeTime(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const diff = nowMs - then;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export const NO_PR_GROUP = 'no-pull-request';

/** Parsed GitHub pull-request coordinates from a PR URL. */
export type GithubPrRef = {
  owner: string;
  repo: string;
  number: number;
  /** Canonical https URL used as a cache / map key. */
  prUrl: string;
};

/**
 * Extract owner/repo/number from a github.com pull URL.
 * Returns null for non-GitHub or malformed URLs.
 */
export function parseGithubPrRef(
  prUrl: string | null | undefined,
): GithubPrRef | null {
  if (!prUrl?.trim()) return null;
  try {
    const u = new URL(prUrl.includes('://') ? prUrl : `https://${prUrl}`);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!m) return null;
    const number = Number(m[3]);
    if (!Number.isFinite(number) || number <= 0) return null;
    return {
      owner: m[1]!,
      repo: m[2]!,
      number,
      prUrl: `https://github.com/${m[1]}/${m[2]}/pull/${number}`,
    };
  } catch {
    return null;
  }
}

/** Short `#N` label from a PR URL or `owner/repo#N` string. */
export function formatPrNumberLabel(
  prUrlOrLabel: string | null | undefined,
): string | null {
  if (!prUrlOrLabel) return null;
  const ref = parseGithubPrRef(prUrlOrLabel);
  if (ref) return `#${ref.number}`;
  const m = prUrlOrLabel.match(/#(\d+)\s*$/);
  return m ? `#${m[1]}` : null;
}

/**
 * Prefer a known PR title; otherwise the oldest conversation name in the
 * group (Cloud Agents that open a PR usually share that title).
 */
export function resolvePrDisplayName(opts: {
  prTitle?: string | null;
  conversations?: Array<{ name?: string; createdAt?: string }>;
}): string | null {
  const titled = opts.prTitle?.trim();
  if (titled) return titled;

  const named = (opts.conversations ?? [])
    .map((c) => ({
      name: c.name?.trim() || '',
      createdAt: c.createdAt ? Date.parse(c.createdAt) : Number.POSITIVE_INFINITY,
    }))
    .filter((c) => c.name.length > 0 && c.name !== '(unnamed conversation)');
  if (named.length === 0) return null;
  named.sort((a, b) => a.createdAt - b.createdAt);
  return named[0]!.name;
}

export type SortableConversationGroup = {
  key: string;
  totalChargedCents: number | null;
  latestCreatedAt: string | null;
};

/**
 * Order groups for display: by total charged cost or by newest conversation,
 * descending. The no-PR bucket always sorts last.
 */
export function sortConversationGroupsBy<T extends SortableConversationGroup>(
  groups: T[],
  sort: ConversationGroupSort,
): T[] {
  const noPr = groups.filter((g) => g.key === NO_PR_GROUP);
  const rest = groups.filter((g) => g.key !== NO_PR_GROUP);

  const byLatest = (a: T, b: T) => {
    const at = a.latestCreatedAt ? Date.parse(a.latestCreatedAt) : 0;
    const bt = b.latestCreatedAt ? Date.parse(b.latestCreatedAt) : 0;
    return bt - at;
  };

  rest.sort((a, b) => {
    if (sort === 'cost') {
      const ac = a.totalChargedCents;
      const bc = b.totalChargedCents;
      if (ac != null && bc != null && ac !== bc) return bc - ac;
      if (ac != null && bc == null) return -1;
      if (ac == null && bc != null) return 1;
      return byLatest(a, b);
    }
    const byCreated = byLatest(a, b);
    return byCreated !== 0 ? byCreated : a.key.localeCompare(b.key);
  });

  return [...rest, ...noPr];
}

/** Minimal conversation shape for Automations / User-request partitioning. */
export type PartitionableRun = {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  source?: string;
  automationId?: string;
  automationName?: string | null;
  chargedCents: number | null;
  prUrl?: string | null;
  prLabel?: string | null;
  prName?: string | null;
  prNumber?: string | null;
};

export function automationMetaFromRun(run: {
  source?: string;
  automationId?: string;
  automationName?: string | null;
}): { automationId: string; automationName: string | null } | null {
  const id =
    typeof run.automationId === 'string' && run.automationId.trim()
      ? run.automationId.trim()
      : null;
  const source =
    typeof run.source === 'string' ? run.source.trim().toLowerCase() : '';
  const name =
    typeof run.automationName === 'string' && run.automationName.trim()
      ? run.automationName.trim()
      : null;
  if (id) return { automationId: id, automationName: name };
  if (source === 'automations' || source === 'automation') {
    return {
      automationId: '__unscoped_automation__',
      automationName: name ?? 'Automations',
    };
  }
  return null;
}

export function automationDisplayName(
  automationId: string,
  automationName?: string | null,
): string {
  const named = automationName?.trim();
  if (named) return named;
  if (automationId === '__unscoped_automation__') return 'Automations';
  const short = automationId.replace(/-/g, '').slice(0, 8);
  return `Automation ${short}`;
}

export type AutomationRunBucket<T extends PartitionableRun> = {
  automationId: string;
  automationName: string;
  conversations: T[];
  totalChargedCents: number | null;
  latestCreatedAt: string | null;
};

export type ProjectRunBuckets<T extends PartitionableRun> = {
  automations: AutomationRunBucket<T>[];
  userRequests: T[];
};

function sortPartitionableRuns<T extends PartitionableRun>(
  runs: T[],
  sort: ConversationGroupSort,
): T[] {
  return [...runs].sort((a, b) => {
    if (sort === 'cost') {
      const ac = a.chargedCents;
      const bc = b.chargedCents;
      if (ac != null && bc != null && ac !== bc) return bc - ac;
      if (ac != null && bc == null) return -1;
      if (ac == null && bc != null) return 1;
    }
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (at !== bt) return bt - at;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
}

function sumChargedAndLatest<T extends PartitionableRun>(runs: T[]): {
  totalChargedCents: number | null;
  latestCreatedAt: string | null;
} {
  let charged: number | null = null;
  let latest: string | null = null;
  let latestMs = 0;
  for (const run of runs) {
    if (run.chargedCents != null) charged = (charged ?? 0) + run.chargedCents;
    const createdMs = run.createdAt ? Date.parse(run.createdAt) : 0;
    if (createdMs > latestMs) {
      latestMs = createdMs;
      latest = run.createdAt ?? null;
    }
  }
  return { totalChargedCents: charged, latestCreatedAt: latest };
}

/**
 * Split runs into Automations (by automationId) and User requests.
 * Sorting applies within each bucket (automations by total, runs by cost/created).
 */
export function partitionProjectRunsByAutomation<T extends PartitionableRun>(
  runs: T[],
  sort: ConversationGroupSort = 'cost',
): ProjectRunBuckets<T> {
  const byAutomation = new Map<string, { name: string | null; runs: T[] }>();
  const userRequests: T[] = [];

  for (const run of runs) {
    const meta = automationMetaFromRun(run);
    if (!meta) {
      userRequests.push(run);
      continue;
    }
    const cur = byAutomation.get(meta.automationId);
    if (cur) {
      cur.runs.push(run);
      if (!cur.name && meta.automationName) cur.name = meta.automationName;
    } else {
      byAutomation.set(meta.automationId, {
        name: meta.automationName,
        runs: [run],
      });
    }
  }

  const automations: AutomationRunBucket<T>[] = [...byAutomation.entries()].map(
    ([automationId, bucket]) => {
      const conversations = sortPartitionableRuns(bucket.runs, sort);
      const totals = sumChargedAndLatest(conversations);
      return {
        automationId,
        automationName: automationDisplayName(automationId, bucket.name),
        conversations,
        totalChargedCents: totals.totalChargedCents,
        latestCreatedAt: totals.latestCreatedAt,
      };
    },
  );

  automations.sort((a, b) => {
    if (sort === 'cost') {
      const ac = a.totalChargedCents;
      const bc = b.totalChargedCents;
      if (ac != null && bc != null && ac !== bc) return bc - ac;
      if (ac != null && bc == null) return -1;
      if (ac == null && bc != null) return 1;
    }
    const at = a.latestCreatedAt ? Date.parse(a.latestCreatedAt) : 0;
    const bt = b.latestCreatedAt ? Date.parse(b.latestCreatedAt) : 0;
    if (at !== bt) return bt - at;
    return a.automationName.localeCompare(b.automationName);
  });

  return {
    automations,
    userRequests: sortPartitionableRuns(userRequests, sort),
  };
}
