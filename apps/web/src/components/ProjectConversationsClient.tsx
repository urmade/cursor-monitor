'use client';

import { EmptyState, Panel, PanelBody, PanelHeader } from '@nexus/ui';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { RunStatusBadge } from './RunStatusBadge';
import {
  formatCentsUsd,
  formatRelativeTime,
  sortConversationGroupsBy,
  type ConversationGroupSort,
} from '../lib/monitoring-format';

export type ProjectConversationRow = {
  id: string;
  name: string;
  status?: string;
  chargedCents: number | null;
  createdAt?: string;
};

export type ProjectConversationGroupView = {
  key: string;
  prUrl: string | null;
  prLabel: string | null;
  branch?: string;
  conversations: ProjectConversationRow[];
  totalChargedCents: number | null;
  totalRawCents: number | null;
  latestCreatedAt: string | null;
};

function SortControl({
  active,
  onChange,
  pending,
}: {
  active: ConversationGroupSort;
  onChange: (sort: ConversationGroupSort) => void;
  pending: boolean;
}) {
  const options: Array<{ slug: ConversationGroupSort; label: string }> = [
    { slug: 'cost', label: 'Total cost' },
    { slug: 'created', label: 'Created at' },
  ];
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-subtle">Sort</span>
      <div
        className="inline-flex items-center rounded-md border border-border bg-surface p-0.5"
        aria-busy={pending || undefined}
      >
        {options.map((opt) => (
          <button
            key={opt.slug}
            type="button"
            onClick={() => onChange(opt.slug)}
            aria-pressed={active === opt.slug}
            className={
              active === opt.slug
                ? 'rounded bg-[var(--nx-selected)] px-2 py-1 text-xs font-medium text-fg'
                : 'rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg'
            }
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Client-side PR-group list + sort control. Sorting is pure in-memory so
 * flipping "Total cost" / "Created at" is near-instant (no server round-trip).
 */
export function ProjectConversationsClient({
  projectHref,
  initialSort,
  groups,
  prTitlePrefix,
}: {
  projectHref: string;
  initialSort: ConversationGroupSort;
  groups: ProjectConversationGroupView[];
  prTitlePrefix: string;
}) {
  const [sort, setSort] = useState<ConversationGroupSort>(initialSort);
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(
    () => sortConversationGroupsBy(groups, sort),
    [groups, sort],
  );

  if (sorted.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No conversations in this project"
          description="Cloud Agents started against this repository will appear here."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <SortControl
          active={sort}
          pending={pending}
          onChange={(next) => {
            startTransition(() => setSort(next));
            const url =
              next === 'cost' ? projectHref : `${projectHref}?sort=${next}`;
            window.history.replaceState(null, '', url);
          }}
        />
      </div>
      {sorted.map((group) => (
        <Panel key={group.key}>
          <PanelHeader>
            <div className="flex min-w-0 items-baseline gap-2">
              {group.prUrl ? (
                <a
                  href={group.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-accent hover:underline"
                >
                  {prTitle(group.prLabel ?? group.prUrl, prTitlePrefix)}
                </a>
              ) : (
                <span className="text-sm font-medium text-fg-muted">
                  No pull request
                </span>
              )}
              {group.branch ? (
                <span className="truncate font-mono text-xs text-fg-subtle">
                  {group.branch}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-baseline gap-2">
              <span className="text-xs text-fg-subtle">
                {group.conversations.length} conversation
                {group.conversations.length === 1 ? '' : 's'}
              </span>
              <span className="text-sm font-medium tabular-nums text-fg">
                {formatCentsUsd(group.totalChargedCents)}
              </span>
            </div>
          </PanelHeader>
          <PanelBody className="p-0">
            <ul className="divide-y divide-border">
              {group.conversations.map((agent) => (
                <li key={`${group.key}-${agent.id}`}>
                  <Link
                    href={`${projectHref}/conversations/${encodeURIComponent(agent.id)}`}
                    className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--nx-hover)]"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {agent.name}
                    </span>
                    <RunStatusBadge status={agent.status} />
                    <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums text-fg">
                      {formatCentsUsd(agent.chargedCents)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs text-fg-subtle">
                      {agent.createdAt
                        ? formatRelativeTime(agent.createdAt)
                        : '—'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      ))}
    </div>
  );
}

function prTitle(label: string, project: string): string {
  const prefix = `${project}#`;
  return label.startsWith(prefix) ? `#${label.slice(prefix.length)}` : label;
}
