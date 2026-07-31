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
