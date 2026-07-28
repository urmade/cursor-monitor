'use client';

import { useState } from 'react';
import { Badge, Button, CostSourceBadge, formatMicroUsdDisplay } from '@nexus/ui';

export type RunRow = {
  id: string;
  status: string;
  headline?: string | null;
  outcome?: string | null;
  durationMs?: number | null;
  tokens?: Record<string, unknown> | null;
  costMicroUsd?: string | null;
  costSource?: string | null;
  costEstimateMicroUsd?: string | null;
  providerUrl?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  createdAt: string;
  report?: {
    headline: string;
    summary: string;
    outcome: string;
    confidence?: string | null;
    assumptions: string[];
    notVerified: string[];
  } | null;
};

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function tokenTotal(tokens: Record<string, unknown> | null | undefined): string {
  if (!tokens) return '—';
  const total = tokens.total;
  if (typeof total === 'number') {
    if (total >= 1000) return `${Math.round(total / 1000)}k tokens`;
    return `${total} tokens`;
  }
  return '—';
}

function statusTone(
  status: string,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'running' || status === 'launched' || status === 'pending')
    return 'info';
  if (status === 'completed_no_report' || status === 'expired') return 'warning';
  if (
    status === 'failed' ||
    status === 'launch_failed' ||
    status === 'cancelled'
  )
    return 'danger';
  return 'neutral';
}

export function RunTimeline({
  runs,
  workItemId,
  projectKey,
  itemKey,
  canLaunch,
  canCancel,
  launchAction,
  cancelAction,
}: {
  runs: RunRow[];
  workItemId: string;
  projectKey: string;
  itemKey: string;
  canLaunch: boolean;
  canCancel: boolean;
  launchAction: (formData: FormData) => Promise<void>;
  cancelAction: (formData: FormData) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const active = runs.find((r) =>
    ['pending', 'launched', 'running'].includes(r.status),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Agent runs</h3>
        {canLaunch && !active ? (
          <form action={launchAction}>
            <input type="hidden" name="workItemId" value={workItemId} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="itemKey" value={itemKey} />
            <Button type="submit" size="sm">
              Run stage ▸
            </Button>
          </form>
        ) : null}
        {active && canCancel ? (
          <form action={cancelAction}>
            <input type="hidden" name="runId" value={active.id} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="itemKey" value={itemKey} />
            <Button type="submit" variant="ghost" size="sm">
              Cancel run
            </Button>
          </form>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-fg-muted">No runs yet.</p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => {
            const expanded = openId === run.id;
            const headline =
              run.report?.headline ??
              (run.status === 'failed' || run.status === 'launch_failed'
                ? run.errorDetail?.slice(0, 120) ?? run.errorCode ?? 'Failed'
                : run.status === 'completed_no_report'
                  ? 'Finished without a stage report'
                  : null);
            return (
              <li
                key={run.id}
                className="rounded-md border border-border bg-surface px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span
                        className={
                          ['pending', 'launched', 'running'].includes(run.status)
                            ? 'text-accent'
                            : 'text-fg-muted'
                        }
                      >
                        ●
                      </span>
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      <span className="text-xs text-fg-muted">
                        {formatDuration(run.durationMs)} · {tokenTotal(run.tokens)}
                        {run.costMicroUsd != null && run.costMicroUsd !== '' ? (
                          <>
                            {' '}
                            · {formatMicroUsdDisplay(run.costMicroUsd)}{' '}
                            <CostSourceBadge
                              source={run.costSource ?? 'estimated'}
                              className="inline-flex align-middle"
                            />
                          </>
                        ) : null}
                      </span>
                    </div>
                    {headline ? (
                      <p className="mt-1 truncate text-sm text-fg">{headline}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {run.providerUrl ? (
                      <a
                        href={run.providerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-link hover:underline"
                      >
                        Cursor
                      </a>
                    ) : null}
                    {run.report ? (
                      <button
                        type="button"
                        className="text-xs text-fg-muted hover:text-fg"
                        onClick={() =>
                          setOpenId(expanded ? null : run.id)
                        }
                      >
                        {expanded ? '▾ collapse' : '▸ expand'}
                      </button>
                    ) : null}
                  </div>
                </div>
                {expanded && run.report ? (
                  <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                    <div className="text-xs text-fg-subtle">
                      outcome {run.report.outcome}
                      {run.report.confidence
                        ? ` · confidence ${run.report.confidence}`
                        : ''}
                    </div>
                    {run.report.summary ? (
                      <p className="whitespace-pre-wrap text-fg-muted">
                        {run.report.summary}
                      </p>
                    ) : null}
                    {run.report.assumptions.length > 0 ? (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-fg-subtle">
                          Assumptions
                        </div>
                        <ul className="mt-1 list-disc pl-4 text-fg-muted">
                          {run.report.assumptions.map((a) => (
                            <li key={a}>{a}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {run.report.notVerified.length > 0 ? (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-fg-subtle">
                          Not verified
                        </div>
                        <ul className="mt-1 list-disc pl-4 text-fg-muted">
                          {run.report.notVerified.map((a) => (
                            <li key={a}>{a}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
