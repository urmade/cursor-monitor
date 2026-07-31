'use client';

import { Badge, EmptyState, Panel } from '@nexus/ui';
import type { HookSignalsTree } from '../server/hook-signals';

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

export function HookSignalsDashboard({ tree }: { tree: HookSignalsTree }) {
  if (tree.users.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No hook signals yet"
          description="Install the stop hook from Setup, then finish an agent turn. Signals show up here grouped by user → repo → conversation."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        {tree.totalEvents} recent signal{tree.totalEvents === 1 ? '' : 's'}
        {tree.truncated ? ' (showing latest 500)' : ''} · grouped by user → repo →
        conversation
      </p>

      {tree.users.map((user) => (
        <details
          key={user.userEmail}
          open
          className="rounded-md border border-border bg-surface"
        >
          <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-fg">{user.userEmail}</div>
                <div className="text-xs text-fg-muted">
                  {user.repos.length} repo{user.repos.length === 1 ? '' : 's'} ·{' '}
                  {user.eventCount} signal{user.eventCount === 1 ? '' : 's'} ·
                  latest {formatWhen(user.latestAt)}
                </div>
              </div>
            </div>
          </summary>
          <div className="space-y-2 border-t border-border px-3 py-2">
            {user.repos.map((repo) => (
              <details
                key={`${user.userEmail}:${repo.repo}`}
                open
                className="rounded-md border border-border bg-canvas"
              >
                <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-fg">{repo.repo}</div>
                      <div className="text-xs text-fg-muted">
                        {repo.branches.length > 0
                          ? `branches: ${repo.branches.join(', ')}`
                          : 'branch unknown'}{' '}
                        · {repo.conversations.length} conversation
                        {repo.conversations.length === 1 ? '' : 's'} ·{' '}
                        {repo.eventCount} signal
                        {repo.eventCount === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                </summary>
                <div className="space-y-2 border-t border-border px-3 py-2">
                  {repo.conversations.map((conv) => (
                    <details
                      key={`${repo.repo}:${conv.conversationId}`}
                      className="rounded-md border border-border bg-surface"
                    >
                      <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-fg">
                            {shortId(conv.conversationId)}
                          </span>
                          <span className="text-xs text-fg-muted">
                            {conv.events.length} turn
                            {conv.events.length === 1 ? '' : 's'} ·{' '}
                            {formatWhen(conv.latestAt)}
                          </span>
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
                            <li
                              key={event.id}
                              className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-xs"
                            >
                              <div className="min-w-0 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge tone={statusTone(event.status)}>
                                    {event.status ?? 'unknown'}
                                  </Badge>
                                  {event.gitBranch ? (
                                    <span className="font-mono text-fg-muted">
                                      @{event.gitBranch}
                                    </span>
                                  ) : null}
                                  {event.model ? (
                                    <span className="text-fg-muted">
                                      {event.model}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="font-mono text-fg-subtle">
                                  gen {shortId(event.generationId ?? '—')}
                                  {event.loopCount != null
                                    ? ` · loop ${event.loopCount}`
                                    : ''}
                                  {event.cursorVersion
                                    ? ` · cursor ${event.cursorVersion}`
                                    : ''}
                                </div>
                                {event.workspaceRoot ? (
                                  <div className="truncate font-mono text-fg-subtle">
                                    {event.workspaceRoot}
                                  </div>
                                ) : null}
                              </div>
                              <div className="shrink-0 text-fg-muted">
                                {formatWhen(event.receivedAt)}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
