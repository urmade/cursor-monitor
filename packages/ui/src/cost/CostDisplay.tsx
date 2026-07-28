import { Badge } from '../primitives/Badge';

export type CostSourceLabel = 'estimated' | 'provider' | 'admin_reconciled' | 'mixed';

const SOURCE_LABEL: Record<CostSourceLabel, string> = {
  estimated: 'Estimate',
  provider: 'Provider',
  admin_reconciled: 'Reconciled',
  mixed: 'Mixed',
};

export function CostSourceBadge({
  source,
  className,
}: {
  source: CostSourceLabel | string | null | undefined;
  className?: string;
}) {
  const key = (source ?? 'estimated') as CostSourceLabel;
  const label = SOURCE_LABEL[key] ?? 'Estimate';
  const tone =
    key === 'provider' || key === 'admin_reconciled'
      ? 'success'
      : key === 'mixed'
        ? 'warning'
        : 'neutral';
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

export function formatMicroUsdDisplay(micro: string | bigint | null | undefined): string {
  if (micro == null) return '—';
  const n = typeof micro === 'bigint' ? micro : BigInt(micro);
  const negative = n < BigInt(0);
  const abs = negative ? -n : n;
  const cents = (abs + BigInt(5000)) / BigInt(10000);
  if (cents === BigInt(0) && abs > BigInt(0)) return negative ? '<-$0.01' : '<$0.01';
  const dollars = Number(cents) / 100;
  const formatted = dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return negative ? `-${formatted}` : formatted;
}
