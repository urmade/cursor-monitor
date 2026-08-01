'use client';

import { EmptyState, Panel, PanelBody, PanelHeader } from '@nexus/ui';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { LocalRequestsPanel } from './HookSignalsDashboard';
import { RunStatusBadge } from './RunStatusBadge';
import {
  formatCentsUsd,
  formatRelativeTime,
  partitionProjectRunsByAutomation,
  type ConversationGroupSort,
} from '../lib/monitoring-format';
import type { HookRepoBucket } from '../server/hook-signals';

export type ProjectConversationRow = {
  id: string;
  name: string;
  status?: string;
  chargedCents: number | null;
  createdAt?: string;
  source?: string;
  automationId?: string;
  automationName?: string | null;
  prUrl?: string | null;
  prLabel?: string | null;
  prName?: string | null;
  prNumber?: string | null;
};

export type ProjectAutomationGroupView = {
  automationId: string;
  automationName: string;
  totalChargedCents: number | null;
  latestCreatedAt: string | null;
  conversations: ProjectConversationRow[];
};

export type ProjectSectionsView = {
  automations: ProjectAutomationGroupView[];
  /** Non-automation Cloud Agent runs (formerly "user requests"). */
  userRequests: ProjectConversationRow[];
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

function ImpactedPr({
  run,
}: {
  run: Pick<
    ProjectConversationRow,
    'prUrl' | 'prName' | 'prNumber' | 'prLabel'
  >;
}) {
  if (!run.prUrl && !run.prLabel) return null;
  const label =
    run.prName && run.prNumber
      ? `${run.prName} (${run.prNumber})`
      : run.prName || run.prNumber || run.prLabel;
  if (!label) return null;
  if (run.prUrl) {
    return (
      <a
        href={run.prUrl}
        target="_blank"
        rel="noreferrer"
        className="max-w-[14rem] truncate text-xs text-accent hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </a>
    );
  }
  return (
    <span className="max-w-[14rem] truncate text-xs text-fg-subtle">{label}</span>
  );
}

function RunRowLink({
  projectHref,
  run,
}: {
  projectHref: string;
  run: ProjectConversationRow;
}) {
  return (
    <li>
      <Link
        href={`${projectHref}/conversations/${encodeURIComponent(run.id)}`}
        className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--nx-hover)]"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{run.name}</span>
        <ImpactedPr run={run} />
        <RunStatusBadge status={run.status} />
        <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums text-fg">
          {formatCentsUsd(run.chargedCents)}
        </span>
        <span className="w-16 shrink-0 text-right text-xs text-fg-subtle">
          {run.createdAt ? formatRelativeTime(run.createdAt) : '—'}
        </span>
      </Link>
    </li>
  );
}

/**
 * Project detail: Automations, Cloud Agent runs, then local request (hooks).
 * Sorting is pure in-memory within Cloud Agent / Automations buckets.
 */
export function ProjectConversationsClient({
  projectHref,
  initialSort,
  sections,
  localRequests,
}: {
  projectHref: string;
  initialSort: ConversationGroupSort;
  sections: ProjectSectionsView;
  localRequests?: HookRepoBucket | null;
}) {
  const [sort, setSort] = useState<ConversationGroupSort>(initialSort);
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(() => {
    const flat: ProjectConversationRow[] = [
      ...sections.automations.flatMap((a) =>
        a.conversations.map((c) => ({
          ...c,
          automationId: a.automationId,
          automationName: a.automationName,
          source: c.source ?? 'automations',
        })),
      ),
      ...sections.userRequests,
    ];
    return partitionProjectRunsByAutomation(flat, sort);
  }, [sections, sort]);

  const emptyCloud =
    sorted.automations.length === 0 && sorted.userRequests.length === 0;
  const emptyLocal =
    !localRequests || localRequests.conversations.length === 0;

  if (emptyCloud && emptyLocal) {
    return (
      <Panel>
        <EmptyState
          title="No conversations in this project"
          description="Cloud Agents, Automations, and local requests against this repository will appear here."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
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

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Automations</h2>
        {sorted.automations.length === 0 ? (
          <Panel>
            <PanelBody>
              <p className="text-sm text-fg-muted">
                No automation runs attributed to this repository yet. Connect a
                team Admin API key (admin:*) or use keys that own Automations to
                populate this section.
              </p>
            </PanelBody>
          </Panel>
        ) : (
          sorted.automations.map((group) => (
            <Panel key={group.automationId}>
              <PanelHeader>
                <div className="min-w-0">
                  <span className="text-sm font-medium text-fg">
                    {group.automationName}
                  </span>
                  <span className="ml-2 text-xs text-fg-subtle">
                    {group.conversations.length} run
                    {group.conversations.length === 1 ? '' : 's'}
                  </span>
                </div>
                <span className="text-sm font-medium tabular-nums text-fg">
                  {formatCentsUsd(group.totalChargedCents)}
                </span>
              </PanelHeader>
              <PanelBody className="p-0">
                <ul className="divide-y divide-border">
                  {group.conversations.map((run) => (
                    <RunRowLink
                      key={`${group.automationId}-${run.id}`}
                      projectHref={projectHref}
                      run={run}
                    />
                  ))}
                </ul>
              </PanelBody>
            </Panel>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Cloud Agent</h2>
        {sorted.userRequests.length === 0 ? (
          <Panel>
            <PanelBody>
              <p className="text-sm text-fg-muted">
                No Cloud Agent conversations in this repository yet.
              </p>
            </PanelBody>
          </Panel>
        ) : (
          <Panel>
            <PanelBody className="p-0">
              <ul className="divide-y divide-border">
                {sorted.userRequests.map((run) => (
                  <RunRowLink
                    key={`cloud-${run.id}`}
                    projectHref={projectHref}
                    run={run}
                  />
                ))}
              </ul>
            </PanelBody>
          </Panel>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">local request</h2>
        <LocalRequestsPanel bucket={localRequests ?? null} />
      </section>
    </div>
  );
}
