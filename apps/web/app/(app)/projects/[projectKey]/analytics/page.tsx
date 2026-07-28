import Link from 'next/link';
import {
  getProjectByKey,
  projectAnalytics,
  latestBacktest,
  runBacktest,
  analyticsToCsv,
} from '@nexus/core';
import {
  Badge,
  Button,
  Panel,
  PanelBody,
  PanelHeader,
  formatMicroUsdDisplay,
} from '@nexus/ui';
import { RunBacktestButton } from '../../../../../src/components/RunBacktestButton';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

async function actionRunBacktest(formData: FormData) {
  'use server';
  const projectId = String(formData.get('projectId') ?? '');
  const { ctx } = await requireSession();
  await runBacktest(ctx, { projectId });
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const days = Math.max(1, Number(sp.days ?? '30'));
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  // days=1 → complete UTC yesterday (analytics_daily path); else rolling window.
  let from: Date;
  let to: Date;
  if (days === 1) {
    const today = new Date();
    const y = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1),
    );
    from = y;
    to = new Date(y.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else {
    to = new Date();
    from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  }
  const [summaryR, backtestR] = await Promise.all([
    projectAnalytics(ctx, project.value.id, { from, to }),
    latestBacktest(ctx, { projectId: project.value.id }),
  ]);

  const summary = summaryR.ok ? summaryR.value : null;
  const backtest = backtestR.ok ? backtestR.value : null;
  const csv = summary ? analyticsToCsv(summary) : '';

  return (
    <div className="space-y-6 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-fg">Analytics</h2>
          <p className="text-sm text-fg-muted">
            Thin metrics for the last {days} days. Numbers reconcile with
            work_items, interventions, and gate_evaluations.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          {[
            { d: 1, label: 'Yesterday' },
            { d: 7, label: '7d' },
            { d: 30, label: '30d' },
            { d: 90, label: '90d' },
          ].map(({ d, label }) => (
            <Link
              key={d}
              href={`/projects/${projectKey}/analytics?days=${d}`}
              className={
                d === days ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg'
              }
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      {!summary ? (
        <p className="text-sm text-danger">Could not load analytics.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Cost per item</span>
              <Badge tone="neutral">{summary.source}</Badge>
            </PanelHeader>
            <PanelBody className="space-y-1 text-sm">
              <div>
                Median{' '}
                <strong>
                  {formatMicroUsdDisplay(summary.costPerItem.medianMicroUsd)}
                </strong>
              </div>
              <div>
                p90{' '}
                <strong>
                  {formatMicroUsdDisplay(summary.costPerItem.p90MicroUsd)}
                </strong>
              </div>
              {Object.entries(summary.costPerItem.byComplexity).map(([c, v]) => (
                <div key={c} className="text-fg-muted">
                  {c}: n={v.n}, median {formatMicroUsdDisplay(v.medianMicroUsd)},
                  p90 {formatMicroUsdDisplay(v.p90MicroUsd)}
                </div>
              ))}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Spend versus budget</span>
            </PanelHeader>
            <PanelBody className="space-y-1 text-sm">
              <div>
                Overruns{' '}
                <strong>{summary.spendVersusBudget.overrunCount}</strong> of{' '}
                {summary.spendVersusBudget.itemCount} budgeted items
              </div>
              <div>
                Median spend/budget ratio:{' '}
                {summary.spendVersusBudget.medianSpendBudgetRatio != null
                  ? summary.spendVersusBudget.medianSpendBudgetRatio.toFixed(2)
                  : '—'}
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Rework</span>
            </PanelHeader>
            <PanelBody className="space-y-1 text-sm">
              <div>
                Rate{' '}
                <strong>{(summary.rework.reworkRate * 100).toFixed(0)}%</strong>{' '}
                ({summary.rework.itemsWithLoops}/{summary.rework.itemCount} items
                with loops)
              </div>
              <div>
                Cost share{' '}
                <strong>
                  {(summary.rework.reworkCostShare * 100).toFixed(0)}%
                </strong>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Gate outcomes</span>
            </PanelHeader>
            <PanelBody className="space-y-1 text-sm">
              {Object.keys(summary.gates).length === 0 ? (
                <div className="text-fg-muted">No gate evaluations in window.</div>
              ) : (
                Object.entries(summary.gates).map(([key, g]) => (
                  <div key={key}>
                    <span className="font-mono text-xs">{key}</span>: Pass {g.pass}{' '}
                    / Warn {g.warn} / Block {g.block} (n={g.total})
                  </div>
                ))
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Human touches</span>
            </PanelHeader>
            <PanelBody className="text-sm">
              Median {summary.humanTouches.medianPerItem ?? '—'} · Mean{' '}
              {summary.humanTouches.meanPerItem != null
                ? summary.humanTouches.meanPerItem.toFixed(1)
                : '—'}{' '}
              per item
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Median time in stage</span>
            </PanelHeader>
            <PanelBody className="space-y-1 text-sm">
              {Object.keys(summary.stageDurations).length === 0 ? (
                <div className="text-fg-muted">No completed stage visits.</div>
              ) : (
                Object.entries(summary.stageDurations).map(([key, s]) => (
                  <div key={key}>
                    {key}:{' '}
                    {s.medianMs != null
                      ? `${Math.round(s.medianMs / 60000)}m`
                      : '—'}{' '}
                    (n={s.n})
                  </div>
                ))
              )}
            </PanelBody>
          </Panel>
        </div>
      )}

      <Panel>
        <PanelHeader>
          <span className="text-sm font-medium">Estimate backtest</span>
        </PanelHeader>
        <PanelBody className="space-y-3 text-sm">
          {backtest ? (
            <>
              <div>
                Coverage{' '}
                <strong>{(backtest.coverage * 100).toFixed(0)}%</strong> · p50
                bias{' '}
                <strong>
                  {backtest.p50Bias != null ? backtest.p50Bias.toFixed(2) : '—'}
                </strong>{' '}
                · MAPE{' '}
                <strong>
                  {backtest.mape != null
                    ? `${(backtest.mape * 100).toFixed(0)}%`
                    : '—'}
                </strong>{' '}
                · n={backtest.sampleSize}
              </div>
              <p className="text-fg-muted">{backtest.interpretation}</p>
            </>
          ) : (
            <p className="text-fg-muted">No backtest has been run yet.</p>
          )}
          <form action={actionRunBacktest}>
            <input type="hidden" name="projectId" value={project.value.id} />
            <RunBacktestButton />
          </form>
        </PanelBody>
      </Panel>

      {csv ? (
        <Panel>
          <PanelHeader>
            <span className="text-sm font-medium">CSV export</span>
          </PanelHeader>
          <PanelBody>
            <pre className="overflow-x-auto text-xs text-fg-muted">{csv}</pre>
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  );
}
