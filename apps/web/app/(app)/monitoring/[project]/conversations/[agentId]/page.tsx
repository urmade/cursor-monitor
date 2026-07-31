import Link from 'next/link';
import { Panel, PanelBody } from '@nexus/ui';
import { InfoHint } from '../../../../../../src/components/InfoHint';
import { RunStatusBadge } from '../../../../../../src/components/RunStatusBadge';
import {
  aggregateUsageCost,
  extractPrLinksFromGit,
  formatCentsUsd,
  formatDurationMs,
  formatPrNumberLabel,
  resolveCursorAuth,
  resolvePrDisplayName,
  runDidNotFinish,
  runWallClockMs,
  type AgentPrLink,
} from '../../../../../../src/server/cursor';
import { resolveGithubPrTitles } from '../../../../../../src/server/github-pr-titles';

export const dynamic = 'force-dynamic';

const CHARGED_HINT =
  'What Cursor actually billed to your account for this run, after plan pricing, credits and other billing adjustments. This is the number you pay.';
const RAW_HINT =
  'The list price of the model tokens this run consumed, before Cursor’s billing adjustments. The gap between raw and charged is the effect of your plan.';

type RunRow = {
  id: string;
  status: string;
  createdAt?: string;
  wallClockMs: number | null;
  chargedCents?: number;
  rawCostCents?: number;
  prs: AgentPrLink[];
  branch?: string;
};

function shortRunId(id: string): string {
  return id.replace(/^run-/, '').slice(0, 8);
}

function StatCard({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <Panel>
      <PanelBody className="px-3 py-2">
        <div className="text-xs text-fg-subtle">{label}</div>
        <div
          className={`mt-0.5 text-lg font-medium tabular-nums ${
            danger ? 'text-danger-fg' : 'text-fg'
          }`}
        >
          {value}
        </div>
        {hint ? <div className="mt-0.5 text-[11px] text-fg-subtle">{hint}</div> : null}
      </PanelBody>
    </Panel>
  );
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ project: string; agentId: string }>;
}) {
  const { project: rawProject, agentId: rawId } = await params;
  const project = decodeURIComponent(rawProject);
  const agentId = decodeURIComponent(rawId);
  const projectHref = `/monitoring/${encodeURIComponent(project)}`;

  const auth = await resolveCursorAuth();
  if (auth.credentials.length === 0) {
    return (
      <div className="space-y-4 p-4">
        <Link href={projectHref} className="text-sm text-accent hover:underline">
          ← {project}
        </Link>
        <p className="text-sm text-danger-fg" role="alert">
          {auth.error ??
            'Connect a personal Cursor API key on the Monitoring page (or set CURSOR_API_KEY).'}
        </p>
      </div>
    );
  }

  // Prefer the credential that owns this agent when multiple org keys are connected.
  let client = auth.client!;
  for (const cred of auth.credentials) {
    try {
      await cred.client.getAgent(agentId);
      client = cred.client;
      break;
    } catch {
      // try next
    }
  }
  let error: string | null = null;
  let agentName = agentId;
  let agentStatus: string | undefined;
  let agentUrl: string | undefined;
  let runs: RunRow[] = [];
  let agentPrs: AgentPrLink[] = [];
  let chargedSum: number | null = null;
  let rawSum: number | null = null;

  try {
    const [agent, runsPage, usage] = await Promise.all([
      client.getAgent(agentId).catch(() => null),
      client.listRuns(agentId, { limit: 100 }),
      client.getUsage(agentId).catch(() => null),
    ]);

    if (agent) {
      agentName = agent.name?.trim() || agent.id;
      agentStatus = agent.status;
      agentUrl = typeof agent.url === 'string' ? agent.url : undefined;
    }

    const usageByRun = new Map(
      (usage?.runs ?? []).map((r) => [
        r.id,
        {
          chargedCents: r.cost?.chargedCents,
          rawCostCents: r.cost?.rawCostCents,
        },
      ]),
    );

    const agg = aggregateUsageCost(usage, runsPage.items.length);
    chargedSum = agg.chargedSumCents ?? agg.providerChargedCents;
    rawSum = agg.rawSumCents ?? agg.providerRawCents;

    runs = runsPage.items.map((run) => {
      const fromUsage = usageByRun.get(run.id);
      return {
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        wallClockMs: runWallClockMs(run),
        chargedCents: fromUsage?.chargedCents,
        rawCostCents: fromUsage?.rawCostCents,
        prs: extractPrLinksFromGit(run.git),
        branch: run.git?.branches?.find((b) => b.branch)?.branch,
      };
    });

    // Prefer newest run status over v1 agent.status (always ACTIVE).
    const newestRun = [...runs].sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bt - at;
    })[0];
    if (newestRun?.status) agentStatus = newestRun.status;

    agentPrs = runs.find((run) => run.prs.length)?.prs ?? [];
    if (agentPrs.length > 0) {
      const titles = await resolveGithubPrTitles(agentPrs.map((p) => p.prUrl));
      agentPrs = agentPrs.map((pr) => {
        const title = titles.get(pr.prUrl);
        return title ? { ...pr, title } : pr;
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const unfinished = runs.filter((r) => runDidNotFinish(r.status));

  return (
    <div className="space-y-4 p-4">
      <div>
        <Link
          href={projectHref}
          className="text-xs text-fg-subtle hover:text-fg"
        >
          ← {project}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <div className="mb-1 font-mono text-xs text-fg-muted">Conversation</div>
            <h1 className="flex items-center gap-2 text-xl font-medium tracking-tight text-fg">
              <span className="truncate">{agentName}</span>
              <RunStatusBadge status={agentStatus} />
            </h1>
            <p className="mt-1 text-sm text-fg-muted">
              {agentPrs.length > 0 ? (
                <>
                  Targets{' '}
                  {agentPrs.map((pr, i) => {
                    const name =
                      resolvePrDisplayName({
                        prTitle: pr.title,
                        conversations: [{ name: agentName }],
                      }) ?? formatPrNumberLabel(pr.prUrl) ?? pr.label;
                    const number = formatPrNumberLabel(pr.prUrl);
                    return (
                      <span key={pr.prUrl}>
                        {i > 0 ? ', ' : null}
                        <a
                          href={pr.prUrl}
                          className="text-accent hover:underline"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {name}
                          {number && name !== number ? (
                            <span className="ml-1 font-mono text-xs text-fg-subtle">
                              {number}
                            </span>
                          ) : null}
                        </a>
                      </span>
                    );
                  })}
                  {' · '}
                </>
              ) : (
                <>No pull request yet · </>
              )}
              {agentUrl ? (
                <a
                  href={agentUrl}
                  className="text-accent hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Cursor ↗
                </a>
              ) : (
                <span className="font-mono text-xs text-fg-subtle">{agentId}</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-danger-fg" role="alert">
          Failed to load conversation: {error}
        </p>
      ) : null}

      {!error ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Charged" value={formatCentsUsd(chargedSum)} hint="what you pay" />
            <StatCard label="Raw cost" value={formatCentsUsd(rawSum)} hint="token list price" />
            <StatCard
              label="Runs"
              value={String(runs.length)}
            />
            <StatCard
              label="Didn’t finish"
              value={String(unfinished.length)}
              danger={unfinished.length > 0}
            />
          </div>

          {unfinished.length > 0 ? (
            <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg" role="alert">
              {unfinished.length} run{unfinished.length === 1 ? '' : 's'} didn’t
              finish — {unfinished.map((r) => r.status.toLowerCase()).join(', ')}.
              Charged cost may still apply for the tokens consumed.
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <thead className="bg-surface text-fg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1">
                      Charged
                      <InfoHint label="Charged" text={CHARGED_HINT} />
                    </span>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1">
                      Raw cost
                      <InfoHint label="Raw cost" text={RAW_HINT} />
                    </span>
                  </th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-fg-muted" colSpan={6}>
                      No runs for this conversation.
                    </td>
                  </tr>
                ) : null}
                {runs.map((run) => {
                  const didNotFinish = runDidNotFinish(run.status);
                  return (
                    <tr
                      key={run.id}
                      className={
                        didNotFinish
                          ? 'bg-danger-bg/40 hover:bg-danger-bg/60'
                          : 'hover:bg-[var(--nx-hover)]'
                      }
                    >
                      <td className="px-3 py-2 font-mono text-xs" title={run.id}>
                        {shortRunId(run.id)}
                      </td>
                      <td className="px-3 py-2">
                        <RunStatusBadge status={run.status} showIdle />
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatDurationMs(run.wallClockMs)}
                      </td>
                      <td className="px-3 py-2 font-medium tabular-nums">
                        {formatCentsUsd(run.chargedCents)}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-fg-muted">
                        {formatCentsUsd(run.rawCostCents)}
                      </td>
                      <td className="px-3 py-2 text-xs text-fg-muted">
                        {run.createdAt
                          ? new Date(run.createdAt).toLocaleString()
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-fg-subtle">
            Duration is wall-clock time: run created → last update, or → now while
            still running. Rows highlighted in red didn’t finish. Cursor reports the
            same <code>git</code> snapshot on every run of a conversation, so PR and
            branch are shown once in the header.
          </p>
        </>
      ) : null}
    </div>
  );
}
