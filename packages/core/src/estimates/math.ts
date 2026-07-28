import type { Complexity, CostEstimate, EstimateSourceMix } from '@nexus/contracts';
import { CostEstimateSchema } from '@nexus/contracts';
import type { MicroUsd } from '../cost/money';

/** Q11 default: minimum comparable items before a range is shown (tiers 1–2). */
export const MIN_N_TIER_1_2 = 5;
/** Tier 3 (org-wide same complexity + pipeline shape) needs a larger sample. */
export const MIN_N_TIER_3 = 8;

export const CACHE_TTL_MS = 60 * 60 * 1000;

export type ComparableItem = {
  id: string;
  projectId: string;
  complexity: Complexity;
  spendMicroUsd: MicroUsd;
  spendSource: string;
  labelKeys: string[];
  /** Sorted stage keys fingerprint for pipeline-shape matching. */
  pipelineFingerprint: string;
  completedAt: Date;
};

/**
 * Empirical quantile with linear interpolation (Hyndman–Fan type 7).
 * `p` in [0, 1]. Empty array returns 0n.
 */
export function empiricalQuantile(sorted: bigint[], p: number): bigint {
  if (sorted.length === 0) return 0n;
  if (sorted.length === 1) return sorted[0]!;
  const clamped = Math.min(1, Math.max(0, p));
  const h = (sorted.length - 1) * clamped;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo]!;
  const w = h - lo;
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  const delta = b - a;
  const scaled = (delta * BigInt(Math.round(w * 1_000_000))) / 1_000_000n;
  return a + scaled;
}

export function sortBigints(values: bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Trim values beyond 3× IQR from the Tukey fences. */
export function trimOutliers(values: bigint[]): bigint[] {
  if (values.length < 4) return [...values];
  const sorted = sortBigints(values);
  const q1 = empiricalQuantile(sorted, 0.25);
  const q3 = empiricalQuantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0n) return sorted;
  const fence = iqr * 3n;
  const low = q1 - fence;
  const high = q3 + fence;
  const kept = sorted.filter((v) => v >= low && v <= high);
  return kept.length > 0 ? kept : sorted;
}

export function sourceMixOf(items: ComparableItem[]): EstimateSourceMix {
  const sources = new Set(
    items.map((i) =>
      i.spendSource === 'admin_reconciled' || i.spendSource === 'provider'
        ? 'reconciled'
        : 'estimated',
    ),
  );
  if (sources.size === 1) {
    return sources.has('reconciled') ? 'reconciled' : 'estimated';
  }
  return 'mixed';
}

export function preferReconciled(
  items: ComparableItem[],
  minN: number = MIN_N_TIER_1_2,
): ComparableItem[] {
  const reconciled = items.filter(
    (i) => i.spendSource === 'admin_reconciled' || i.spendSource === 'provider',
  );
  return reconciled.length >= minN ? reconciled : items;
}

export function sharedLabelCount(a: string[], b: string[]): number {
  const set = new Set(a);
  let n = 0;
  for (const k of b) if (set.has(k)) n += 1;
  return n;
}

export type TierSelection = {
  tier: 1 | 2 | 3 | 4;
  items: ComparableItem[];
  /** Threshold that was unmet for the next narrower tier (for cold-start copy). */
  nextThreshold: number;
};

/**
 * Widen the comparable set until minimum n is met, else cold start (tier 4).
 */
export function selectComparables(
  pool: ComparableItem[],
  opts: {
    projectId: string;
    complexity: Complexity;
    labelKeys: string[];
    pipelineFingerprint: string;
    before?: Date;
  },
): TierSelection {
  const before = opts.before;
  const base = pool.filter((i) => {
    if (i.complexity !== opts.complexity) return false;
    if (before && !(i.completedAt < before)) return false;
    return true;
  });

  const tier1 = base.filter(
    (i) =>
      i.projectId === opts.projectId &&
      sharedLabelCount(i.labelKeys, opts.labelKeys) >= 1,
  );
  if (tier1.length >= MIN_N_TIER_1_2) {
    return { tier: 1, items: tier1, nextThreshold: MIN_N_TIER_1_2 };
  }

  const tier2 = base.filter((i) => i.projectId === opts.projectId);
  if (tier2.length >= MIN_N_TIER_1_2) {
    return { tier: 2, items: tier2, nextThreshold: MIN_N_TIER_1_2 };
  }

  const tier3 = base.filter(
    (i) => i.pipelineFingerprint === opts.pipelineFingerprint,
  );
  if (tier3.length >= MIN_N_TIER_3) {
    return { tier: 3, items: tier3, nextThreshold: MIN_N_TIER_3 };
  }

  // Cold start: report which ladder rung was closest and its threshold.
  if (tier2.length >= tier3.length && tier2.length >= tier1.length) {
    return {
      tier: 4,
      items: tier2.length > 0 ? tier2 : tier1,
      nextThreshold: MIN_N_TIER_1_2,
    };
  }
  if (tier3.length >= tier1.length) {
    return { tier: 4, items: tier3, nextThreshold: MIN_N_TIER_3 };
  }
  return {
    tier: 4,
    items: tier1,
    nextThreshold: MIN_N_TIER_1_2,
  };
}

/** Cache keys MUST include orgId — otherwise a cross-tenant write poisons victims. */
export function cacheKey(parts: {
  orgId: string;
  projectId: string;
  complexity: Complexity;
  labelKeys: string[];
}): string {
  const labels = [...parts.labelKeys].sort().join(',');
  return `est:${parts.orgId}:${parts.projectId}:${parts.complexity}:${labels}`;
}

export function serializeEstimate(estimate: CostEstimate): Record<string, unknown> {
  return CostEstimateSchema.parse(estimate) as unknown as Record<string, unknown>;
}

export function parseEstimate(raw: unknown): CostEstimate {
  return CostEstimateSchema.parse(raw);
}

export function buildRangeEstimate(args: {
  tier: 1 | 2 | 3;
  items: ComparableItem[];
  projectName: string;
  complexity: Complexity;
  durationMs?: number[];
}): CostEstimate {
  const preferred = preferReconciled(args.items);
  const spends = trimOutliers(preferred.map((i) => i.spendMicroUsd));
  const sorted = sortBigints(spends);
  const mix = sourceMixOf(preferred);
  const low = empiricalQuantile(sorted, 0.1);
  const p50 = empiricalQuantile(sorted, 0.5);
  const p90 = empiricalQuantile(sorted, 0.9);
  const tierLabel =
    args.tier === 1
      ? 'same project, complexity, and shared label'
      : args.tier === 2
        ? 'same project and complexity'
        : 'same organisation, complexity, and pipeline shape';
  // Tier 3 must not claim items are "in {project}" — they may be org-wide.
  const where =
    args.tier === 3
      ? `across the organisation (pipeline shape matching ${args.projectName})`
      : `in ${args.projectName}`;
  const basis = `${sorted.length} similar ${capitalize(args.complexity)} items (${tierLabel}) ${where}`;

  const estimate: CostEstimate = {
    kind: 'range',
    tier: args.tier,
    n: sorted.length,
    p50MicroUsd: p50.toString(),
    p90MicroUsd: p90.toString(),
    lowMicroUsd: low.toString(),
    basis,
    computedAt: new Date().toISOString(),
    sourceMix: mix,
  };

  if (args.durationMs && args.durationMs.length > 0) {
    const dSorted = [...args.durationMs].sort((a, b) => a - b);
    estimate.p50DurationMs = Math.round(
      Number(empiricalQuantile(dSorted.map(BigInt), 0.5)),
    );
    estimate.p90DurationMs = Math.round(
      Number(empiricalQuantile(dSorted.map(BigInt), 0.9)),
    );
  }

  return CostEstimateSchema.parse(estimate);
}

export function buildColdStartEstimate(args: {
  n: number;
  complexity: Complexity;
  defaultBudgetMicroUsd: MicroUsd;
  projectName: string;
  /** Threshold for the ladder rung that was closest (B3). */
  rangeAppearsAfter?: number;
  reason?: 'insufficient_history' | 'flag_disabled';
}): CostEstimate {
  const complexityLabel = capitalize(args.complexity);
  const threshold = args.rangeAppearsAfter ?? MIN_N_TIER_1_2;
  const reason = args.reason ?? 'insufficient_history';
  const basis =
    reason === 'flag_disabled'
      ? `Estimates are disabled for this project — showing the ${complexityLabel} default budget of ${formatUsd(args.defaultBudgetMicroUsd)}.`
      : `only ${args.n} comparable ${complexityLabel} item${args.n === 1 ? '' : 's'} in the closest matching set — showing the ${complexityLabel} default budget of ${formatUsd(args.defaultBudgetMicroUsd)}. A range appears after ${threshold} at this tier.`;
  return CostEstimateSchema.parse({
    kind: 'cold_start',
    defaultBudgetMicroUsd: args.defaultBudgetMicroUsd.toString(),
    n: args.n,
    reason,
    tier: 4,
    complexity: args.complexity,
    basis,
  });
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function formatUsd(micro: MicroUsd): string {
  const usd = Number(micro) / 1_000_000;
  return `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;
}
