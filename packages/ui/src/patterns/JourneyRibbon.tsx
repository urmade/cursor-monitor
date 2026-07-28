import { cn } from '../lib/cn';
import { formatMicroUsdDisplay } from '../cost/CostDisplay';

export type JourneyRibbonNode = {
  stageInstanceId: string;
  stageId: string;
  stageKey: string;
  stageName: string;
  visitIndex: number;
  seq: number;
  costMicroUsd: string;
  isRework: boolean;
};

export type JourneyRibbonArc = {
  loopEdgeId: string;
  fromSeq: number;
  toSeq: number;
  reasonCode: string;
  costMicroUsd: string | null;
  costComplete: boolean;
};

export type JourneyRibbonProps = {
  nodes: JourneyRibbonNode[];
  arcs: JourneyRibbonArc[];
  collapsedPairs?: Array<{
    fromStageKey: string;
    toStageKey: string;
    count: number;
    reasonCodes: string[];
  }>;
  accessibleSummary: string;
  className?: string;
};

/**
 * Compact historical path ribbon. Renders from stored stage_instances —
 * never from current pipeline order. Dense loops collapse to pair counts.
 */
export function JourneyRibbon({
  nodes,
  arcs,
  collapsedPairs = [],
  accessibleSummary,
  className,
}: JourneyRibbonProps) {
  if (nodes.length === 0) {
    return (
      <p className={cn('text-sm text-fg-muted', className)} aria-label="No journey yet">
        No stage history yet.
      </p>
    );
  }

  const dense = arcs.length >= 5;

  return (
    <div className={cn('grid gap-2', className)}>
      <p className="sr-only">{accessibleSummary}</p>
      <ol
        className="flex flex-wrap items-center gap-1 text-sm"
        aria-hidden="true"
      >
        {nodes.map((n, i) => (
          <li key={n.stageInstanceId} className="flex items-center gap-1">
            {i > 0 ? (
              <span className="text-fg-muted px-0.5" aria-hidden>
                →
              </span>
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5',
                n.isRework
                  ? 'border-warning/40 bg-warning/10 text-warning'
                  : 'border-border bg-surface',
              )}
              title={
                n.isRework
                  ? `Visit ${n.visitIndex} · ${formatMicroUsdDisplay(n.costMicroUsd)} (rework)`
                  : formatMicroUsdDisplay(n.costMicroUsd)
              }
            >
              <span className="font-medium">{n.stageName}</span>
              {n.visitIndex > 1 ? (
                <span className="text-xs text-fg-muted">({n.visitIndex})</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      {arcs.length > 0 && !dense ? (
        <ul className="grid gap-1 text-xs text-fg-muted" aria-label="Return edges">
          {arcs.map((a) => (
            <li key={a.loopEdgeId}>
              ↺ {a.reasonCode}
              {a.costMicroUsd != null
                ? ` · ${formatMicroUsdDisplay(a.costMicroUsd)}${a.costComplete ? '' : ' (provisional)'}`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {dense && collapsedPairs.length > 0 ? (
        <ul className="grid gap-1 text-xs text-fg-muted" aria-label="Collapsed returns">
          {collapsedPairs.map((p) => (
            <li key={`${p.fromStageKey}-${p.toStageKey}`}>
              ↺ {p.fromStageKey} → {p.toStageKey} ×{p.count}
              {p.reasonCodes.length
                ? ` (${p.reasonCodes.join(', ')})`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
