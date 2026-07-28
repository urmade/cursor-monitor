'use client';

import { CostSourceBadge, formatMicroUsdDisplay } from '@nexus/ui';

export function TicketBudgetBar({
  spentMicro,
  budgetMicro,
  spendSource,
}: {
  spentMicro: string;
  budgetMicro: string | null;
  spendSource: string;
}) {
  const spent = BigInt(spentMicro);
  const budget = budgetMicro ? BigInt(budgetMicro) : null;
  const ratio =
    budget && budget > BigInt(0) ? Math.min(1, Number(spent) / Number(budget)) : 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {formatMicroUsdDisplay(spent)}
          {budget != null ? ` of ${formatMicroUsdDisplay(budget)}` : ''}
        </span>
        <CostSourceBadge source={spendSource} />
      </div>
      {budget != null ? (
        <div
          className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
