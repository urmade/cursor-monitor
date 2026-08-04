'use client';

import {
  Badge,
  EmptyState,
  Panel,
  PanelBody,
  PanelHeader,
  type BadgeTone,
} from '@nexus/ui';
import { useMemo, useState, useTransition } from 'react';
import { RunStatusBadge } from './RunStatusBadge';
import {
  formatCentsUsd,
  formatDurationMs,
  formatRelativeTime,
  groupMonitoringRunsByBranch,
  MONITORING_RUN_KIND_LABELS,
  summarizeLocalStatuses,
  type ConversationGroupSort,
  type MonitoringRunKind,
} from '../lib/monitoring-format';
import type {
  HookConversationBucket,
  HookRepoBucket,
  HookSignalEvent,
} from '../server/hook-signals';
import { AssignHookConversationRepoForm } from './AssignHookConversationRepoForm';

const KIND_TONES: Record<'local', BadgeTone> = {
  local: 'neutral',
};

/** One row in the unified request list (stop-hook local requests). */
type UnifiedRun = {
  kind: Extract<MonitoringRunKind, 'local'>;
  id: string;
  name: string;
  branch: string | null;
  chargedCents: number | null;
  createdAt?: string;
  /** Run-status token for RunStatusBadge (ERROR / FINISHED / …). */
  statusToken?: string;
  local: HookConversationBucket;
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

function DetailLine({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs">
      <span className="w-24 shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 flex-1 text-fg-muted">{children}</span>
    </div>
  );
}

function formatWhen(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shortConversationId(id: string): string {
  // The no-id sentinel reads better in full than truncated.
  if (id === 'Unknown conversation') return id;
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

function statusTone(
  status: string | null,
): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'aborted') return 'warning';
  return 'neutral';
}

function fullEntryJson(event: HookSignalEvent): string {
  return JSON.stringify(
    {
      id: event.id,
      received_at: event.receivedAt,
      conversation_id: event.conversationId,
      generation_id: event.generationId,
      user_email: event.userEmail,
      repo: event.repo,
      git_branch: event.gitBranch,
      workspace_root: event.workspaceRoot,
      workspace_roots: event.workspaceRoots,
      model: event.model,
      model_id: event.modelId,
      model_params: event.modelParams,
      hook_event_name: event.hookEventName,
      cursor_version: event.cursorVersion,
      transcript_path: event.transcriptPath,
      status: event.status,
      loop_count: event.loopCount,
      charged_cents: event.chargedCents,
      cost_source: event.costSource,
      cost_lookup_error: event.costLookupError,
      usage_event: event.usageEvent,
      started_at: event.startedAt,
      finished_at: event.finishedAt,
      duration_ms: event.durationMs,
      payload: event.payload,
    },
    null,
    2,
  );
}

/** Extra facts for local (stop-hook) requests. */
function LocalRunDetails({
  conv,
  allowAssignRepo,
  knownRepos,
}: {
  conv: HookConversationBucket;
  allowAssignRepo?: boolean;
  knownRepos?: string[];
}) {
  const model = conv.events.map((e) => e.model).find(Boolean) ?? null;
  return (
    <div className="space-y-2">
      {allowAssignRepo ? (
        <AssignHookConversationRepoForm
          conversationId={conv.conversationId}
          knownRepos={knownRepos ?? []}
        />
      ) : null}
      <div className="space-y-1.5">
        {conv.userEmail ? (
          <DetailLine label="User">{conv.userEmail}</DetailLine>
        ) : null}
        <DetailLine label="Conversation">
          <span className="font-mono text-fg-subtle">{conv.conversationId}</span>
        </DetailLine>
        <DetailLine label="Turns">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {conv.events.length} turn{conv.events.length === 1 ? '' : 's'}
            {Object.entries(conv.statuses).map(([status, n]) => (
              <Badge key={status} tone={statusTone(status)}>
                {status} ×{n}
              </Badge>
            ))}
          </span>
        </DetailLine>
        {model ? <DetailLine label="Model">{model}</DetailLine> : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {conv.events.map((event) => (
          <li key={event.id} className="px-3 py-2 text-xs">
            <details className="group/event">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={statusTone(event.status)}>
                        {event.status ?? 'unknown'}
                      </Badge>
                      {event.chargedCents != null ? (
                        <Badge tone="info">
                          {formatCentsUsd(event.chargedCents)}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">cost n/a</Badge>
                      )}
                      {event.durationMs != null ? (
                        <Badge tone="info">
                          {formatDurationMs(event.durationMs)}
                        </Badge>
                      ) : null}
                      {event.gitBranch ? (
                        <span className="font-mono text-fg-muted">
                          @{event.gitBranch}
                        </span>
                      ) : null}
                      {event.model ? (
                        <span className="text-fg-muted">{event.model}</span>
                      ) : null}
                    </div>
                    <div className="font-mono text-fg-subtle">
                      id {shortConversationId(event.id)} · gen{' '}
                      {shortConversationId(event.generationId ?? '—')}
                      {event.loopCount != null
                        ? ` · loop ${event.loopCount}`
                        : ''}
                      {event.cursorVersion
                        ? ` · cursor ${event.cursorVersion}`
                        : ''}
                    </div>
                    {event.costLookupError ? (
                      <div className="text-warning-fg">
                        cost lookup: {event.costLookupError}
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-fg-muted">
                    {formatWhen(event.receivedAt)}
                  </div>
                </div>
              </summary>
              <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md border border-border bg-canvas p-3 font-mono text-[11px] leading-relaxed text-fg whitespace-pre-wrap break-all">
                {fullEntryJson(event)}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One local request row. The summary shows kind, name, status, cost and age;
 * expanding reveals per-turn stop-hook details.
 */
function RunRow({
  run,
  allowAssignRepo,
  knownRepos,
}: {
  run: UnifiedRun;
  allowAssignRepo?: boolean;
  knownRepos?: string[];
}) {
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--nx-hover)] [&::-webkit-details-marker]:hidden">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="size-3 shrink-0 text-fg-subtle transition-transform group-open:rotate-90"
            aria-hidden
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <Badge tone={KIND_TONES[run.kind]} className="shrink-0">
            {MONITORING_RUN_KIND_LABELS[run.kind]}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm text-fg">
            {run.name}
          </span>
          <RunStatusBadge status={run.statusToken} />
          <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums text-fg">
            {formatCentsUsd(run.chargedCents)}
          </span>
          <span className="w-16 shrink-0 text-right text-xs text-fg-subtle">
            {run.createdAt ? formatRelativeTime(run.createdAt) : '—'}
          </span>
        </summary>
        <div className="border-t border-border px-3 py-2.5">
          <LocalRunDetails
            conv={run.local}
            allowAssignRepo={allowAssignRepo}
            knownRepos={knownRepos}
          />
        </div>
      </details>
    </li>
  );
}

function BranchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-3.5 shrink-0 text-fg-subtle"
      aria-hidden
    >
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path
        d="M4.5 5.25v5.5M11.5 7.25c0 2.25-2.75 2.75-5 3.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Project detail: local stop-hook requests against this repository, grouped
 * by the branch they target. Sorting is pure in-memory within branch groups.
 */
export function ProjectConversationsClient({
  projectHref,
  initialSort,
  localRequests,
  allowAssignRepo = false,
  knownRepos = [],
}: {
  projectHref: string;
  initialSort: ConversationGroupSort;
  localRequests?: HookRepoBucket | null;
  /** When true, show controls to assign no-repo conversations to a known repo. */
  allowAssignRepo?: boolean;
  knownRepos?: string[];
}) {
  const [sort, setSort] = useState<ConversationGroupSort>(initialSort);
  const [pending, startTransition] = useTransition();

  const groups = useMemo(() => {
    const unified: UnifiedRun[] = (localRequests?.conversations ?? []).map(
      (conv): UnifiedRun => ({
        kind: 'local',
        id: conv.conversationId,
        name: conv.userEmail ?? shortConversationId(conv.conversationId),
        branch: conv.gitBranch,
        chargedCents: conv.chargedCentsTotal,
        createdAt: conv.latestAt || undefined,
        statusToken: summarizeLocalStatuses(conv.statuses),
        local: conv,
      }),
    );
    return groupMonitoringRunsByBranch(unified, sort);
  }, [localRequests, sort]);

  const runCount = groups.reduce((n, g) => n + g.runs.length, 0);

  if (runCount === 0) {
    return (
      <Panel>
        <EmptyState
          title="No local requests in this project"
          description="Stop-hook turns against this repository will appear here."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-fg">
          Requests{' '}
          <span className="text-xs font-normal text-fg-subtle">
            {runCount} · grouped by branch
          </span>
        </h2>
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

      {groups.map((group) => (
        <Panel key={group.key}>
          <PanelHeader>
            <div className="flex min-w-0 items-center gap-2">
              <BranchIcon />
              <span className="truncate font-mono text-sm font-medium text-fg">
                {group.branch ?? 'No branch'}
              </span>
              <span className="shrink-0 text-xs text-fg-subtle">
                {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
              </span>
            </div>
            <span className="text-sm font-medium tabular-nums text-fg">
              {formatCentsUsd(group.totalChargedCents)}
            </span>
          </PanelHeader>
          <PanelBody className="p-0">
            <ul className="divide-y divide-border">
              {group.runs.map((run) => (
                <RunRow
                  key={`${run.kind}-${run.id}`}
                  run={run}
                  allowAssignRepo={allowAssignRepo}
                  knownRepos={knownRepos}
                />
              ))}
            </ul>
          </PanelBody>
        </Panel>
      ))}
    </div>
  );
}
