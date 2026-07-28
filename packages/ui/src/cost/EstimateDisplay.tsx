import { Badge } from '../primitives/Badge';
import { formatMicroUsdDisplay } from './CostDisplay';

export type CostEstimateView =
  | {
      kind: 'range';
      tier: 1 | 2 | 3;
      n: number;
      p50MicroUsd: string;
      p90MicroUsd: string;
      lowMicroUsd: string;
      basis: string;
      sourceMix: string;
    }
  | {
      kind: 'cold_start';
      defaultBudgetMicroUsd: string;
      n: number;
      basis: string;
    };

/** Always labels the number as an estimate and states the basis. */
export function EstimateDisplay({
  estimate,
  className,
}: {
  estimate: CostEstimateView | null | undefined;
  className?: string;
}) {
  if (!estimate) return null;

  if (estimate.kind === 'cold_start') {
    return (
      <div className={className} data-testid="estimate-cold-start">
        <Badge tone="neutral">No ranged estimate yet</Badge>
        <p className="mt-1 text-xs text-fg-muted">{estimate.basis}</p>
        <p className="mt-1 text-sm text-fg">
          Showing complexity default budget{' '}
          <span className="font-medium">
            {formatMicroUsdDisplay(estimate.defaultBudgetMicroUsd)}
          </span>{' '}
          <Badge tone="neutral">Default budget</Badge>
        </p>
      </div>
    );
  }

  return (
    <div className={className} data-testid="estimate-range">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <span className="text-fg-muted">Estimate</span>
        <span className="font-medium text-fg">
          {formatMicroUsdDisplay(estimate.lowMicroUsd)}–
          {formatMicroUsdDisplay(estimate.p90MicroUsd)}
        </span>
        <span className="text-fg-muted">
          (median {formatMicroUsdDisplay(estimate.p50MicroUsd)})
        </span>
        <Badge tone="neutral">Estimate</Badge>
        <Badge tone="neutral">tier {estimate.tier}</Badge>
        <Badge tone="neutral">{estimate.sourceMix}</Badge>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{estimate.basis}</p>
    </div>
  );
}

export function EstimateVersusActual({
  estimate,
  actualMicroUsd,
}: {
  estimate: CostEstimateView | null | undefined;
  actualMicroUsd: string | bigint | null | undefined;
}) {
  if (!estimate || estimate.kind !== 'range' || actualMicroUsd == null) {
    return null;
  }
  const actual =
    typeof actualMicroUsd === 'bigint' ? actualMicroUsd : BigInt(actualMicroUsd);
  const low = BigInt(estimate.lowMicroUsd);
  const high = BigInt(estimate.p90MicroUsd);
  const inside = actual >= low && actual <= high;
  return (
    <div className="mt-2 text-xs" data-testid="estimate-versus-actual">
      <span className="text-fg-muted">Estimate vs actual: </span>
      <span className="font-medium">{formatMicroUsdDisplay(actual)}</span>
      <span className="text-fg-muted">
        {' '}
        vs range {formatMicroUsdDisplay(low)}–{formatMicroUsdDisplay(high)} —{' '}
      </span>
      <Badge tone={inside ? 'success' : 'warning'}>
        {inside ? 'inside range' : 'outside range'}
      </Badge>
    </div>
  );
}
