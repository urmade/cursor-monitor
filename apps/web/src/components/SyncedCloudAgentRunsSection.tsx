import type { SyncedCloudAgentRun } from '@nexus/core';
import { Panel, PanelBody, PanelHeader } from '@nexus/ui';
import {
  formatCentsUsd,
  formatRelativeTime,
} from '../lib/monitoring-format';
import { formatDurationMs } from '../server/cursor';

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

export function SyncedCloudAgentRunsSection({
  runs,
  lastSyncAt,
  error,
}: {
  runs: SyncedCloudAgentRun[];
  lastSyncAt: string | null;
  error: string | null;
}) {
  const automations = runs.filter((r) => Boolean(r.automationId));
  const cloudOnly = runs.filter((r) => !r.automationId);
  const totalCharged = runs.reduce((sum, r) => sum + r.chargedCentsTotal, 0);

  return (
    <section className="space-y-3" aria-labelledby="synced-cloud-agents-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            id="synced-cloud-agents-heading"
            className="text-sm font-medium text-fg"
          >
            Synced Cloud Agents &amp; Automations
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            From the Admin usage cadence job (
            <code className="font-mono">cloudAgentId: &quot;*&quot;</code>
            ). Separate from the live key-bound catalogue above.
            {lastSyncAt
              ? ` Last sync ${formatRelativeTime(lastSyncAt)}.`
              : ' No sync recorded yet.'}
          </p>
        </div>
        {runs.length > 0 ? (
          <p className="text-xs text-fg-subtle tabular-nums">
            {runs.length} run{runs.length === 1 ? '' : 's'}
            {automations.length > 0
              ? ` · ${automations.length} automation`
              : ''}
            {cloudOnly.length > 0
              ? ` · ${cloudOnly.length} cloud agent`
              : ''}
            {' · '}
            {formatCentsUsd(totalCharged)} charged
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-danger-fg" role="alert">
          Synced runs unavailable: {error}
        </p>
      ) : null}

      {!error && runs.length === 0 ? (
        <Panel>
          <PanelBody>
            <p className="text-sm text-fg-muted">
              No cadence-synced Cloud Agent spend yet. Once organisation Admin
              or Team usage keys are connected, the cron job records runs here
              (repo/duration when a matching User/Team key can enrich them).
            </p>
          </PanelBody>
        </Panel>
      ) : null}

      {runs.length > 0 ? (
        <Panel>
          <PanelHeader>
            <span className="text-xs font-medium text-fg-muted">
              Recent synced runs
            </span>
          </PanelHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-border text-xs text-fg-subtle">
                <tr>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Repo</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Last event</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-b border-border/70 last:border-0"
                  >
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-fg">
                        {run.agentName ?? shortId(run.cloudAgentId)}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">
                        {shortId(run.cloudAgentId)}
                        {run.organisationLabel
                          ? ` · ${run.organisationLabel}`
                          : ''}
                        {run.latestModel ? ` · ${run.latestModel}` : ''}
                      </div>
                      {!run.enriched && run.enrichmentError ? (
                        <div className="mt-0.5 text-[11px] text-fg-subtle">
                          Not enriched (no matching user key)
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-fg-muted">
                      {run.automationId ? (
                        <span title={run.automationId}>Automation</span>
                      ) : (
                        'Cloud Agent'
                      )}
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-xs text-fg">
                      {run.targetRepo ?? '—'}
                    </td>
                    <td className="px-3 py-2 align-top tabular-nums text-fg">
                      {formatCentsUsd(run.chargedCentsTotal)}
                    </td>
                    <td className="px-3 py-2 align-top tabular-nums text-fg-muted">
                      {formatDurationMs(run.durationMs)}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-fg-subtle">
                      {formatRelativeTime(run.lastEventAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </section>
  );
}
