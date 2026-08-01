'use client';

import { Badge, EmptyState, Panel } from '@nexus/ui';
import type {
  HookConversationBucket,
  HookRepoBucket,
  HookSignalEvent,
  HookSignalsTree,
} from '../server/hook-signals';
import { formatHookCostUsd, formatRelativeTime } from '../lib/monitoring-format';

function formatWhen(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
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
      payload: event.payload,
    },
    null,
    2,
  );
}

function ConversationBlock({ conv }: { conv: HookConversationBucket }) {
  return (
    <details className="rounded-md border border-border bg-surface">
      <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">local request</Badge>
          <span className="font-mono text-xs text-fg">
            {shortId(conv.conversationId)}
          </span>
          {conv.userEmail ? (
            <span className="text-xs text-fg-muted">{conv.userEmail}</span>
          ) : null}
          <span className="text-xs text-fg-muted">
            {conv.events.length} turn{conv.events.length === 1 ? '' : 's'} ·{' '}
            {formatWhen(conv.latestAt)}
          </span>
          {conv.chargedCentsTotal != null ? (
            <Badge tone="info">{formatHookCostUsd(conv.chargedCentsTotal)}</Badge>
          ) : null}
          {Object.entries(conv.statuses).map(([status, n]) => (
            <Badge key={status} tone={statusTone(status)}>
              {status} ×{n}
            </Badge>
          ))}
        </div>
      </summary>
      <div className="border-t border-border">
        <ul className="divide-y divide-border">
          {conv.events.map((event) => (
            <li key={event.id} className="px-3 py-2 text-xs">
              <details open>
                <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={statusTone(event.status)}>
                          {event.status ?? 'unknown'}
                        </Badge>
                        {event.chargedCents != null ? (
                          <Badge tone="info">
                            {formatHookCostUsd(event.chargedCents)}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">cost n/a</Badge>
                        )}
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
                        id {shortId(event.id)} · gen{' '}
                        {shortId(event.generationId ?? '—')}
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
    </details>
  );
}

/** Local-request (stop-hook) list for one repository — used inside Monitoring. */
export function LocalRequestsPanel({
  bucket,
}: {
  bucket: HookRepoBucket | null;
}) {
  if (!bucket || bucket.conversations.length === 0) {
    return (
      <Panel>
        <div className="px-3 py-3 text-sm text-fg-muted">
          No local requests recorded for this repository yet. Install the stop
          hook from Setup, then finish an agent turn locally.
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">
        {bucket.eventCount} signal{bucket.eventCount === 1 ? '' : 's'} ·{' '}
        {bucket.conversations.length} conversation
        {bucket.conversations.length === 1 ? '' : 's'}
        {bucket.chargedCentsTotal != null
          ? ` · ${formatHookCostUsd(bucket.chargedCentsTotal)} charged`
          : ''}
        {bucket.latestAt
          ? ` · latest ${formatRelativeTime(bucket.latestAt)}`
          : ''}
      </p>
      {bucket.conversations.map((conv) => (
        <ConversationBlock
          key={conv.conversationId}
          conv={conv}
        />
      ))}
    </div>
  );
}

export function HookSignalsDashboard({ tree }: { tree: HookSignalsTree }) {
  if (tree.repos.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No local requests yet"
          description="Install the stop hook from Setup, then finish an agent turn. Signals show up in Monitoring grouped by repository."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        {tree.totalEvents} recent signal{tree.totalEvents === 1 ? '' : 's'}
        {tree.truncated ? ' (showing latest 500)' : ''} · grouped by repository ·
        marked as local request · expand a turn for the full log entry
      </p>

      {tree.repos.map((repo) => (
        <details
          key={repo.repo}
          open
          className="rounded-md border border-border bg-surface"
        >
          <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-sm font-medium text-fg">
                  {repo.repo}
                </div>
                <div className="text-xs text-fg-muted">
                  {repo.branches.length > 0
                    ? `branches: ${repo.branches.join(', ')}`
                    : 'branch unknown'}{' '}
                  · {repo.conversations.length} conversation
                  {repo.conversations.length === 1 ? '' : 's'} ·{' '}
                  {repo.eventCount} signal{repo.eventCount === 1 ? '' : 's'}
                  {repo.chargedCentsTotal != null
                    ? ` · ${formatHookCostUsd(repo.chargedCentsTotal)}`
                    : ''}{' '}
                  · latest {formatWhen(repo.latestAt)}
                </div>
              </div>
            </div>
          </summary>
          <div className="space-y-2 border-t border-border px-3 py-2">
            {repo.conversations.map((conv) => (
              <ConversationBlock
                key={`${repo.repo}:${conv.conversationId}`}
                conv={conv}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
