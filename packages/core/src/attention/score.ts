import type {
  AttentionKind,
  AttentionWeights,
  ScoreBreakdown,
} from '@nexus/contracts';

export type ScoreInput = {
  kind: AttentionKind;
  createdAt: Date;
  complexity: 'low' | 'medium' | 'high';
  spentMicroUsd: bigint;
  loopCount: number;
  snoozedUntil: Date | null;
  now: Date;
  weights: AttentionWeights;
};

function ageBoost(hoursOpen: number, weights: AttentionWeights): number {
  const capped = Math.min(hoursOpen, weights.ageLogCapHours);
  const raw = Math.log1p(capped) * weights.ageLogMultiplier;
  return Math.round(raw * 10) / 10;
}

function complexityBoost(
  complexity: ScoreInput['complexity'],
  weights: AttentionWeights,
): number {
  if (complexity === 'high') return weights.complexityHigh;
  if (complexity === 'medium') return weights.complexityMedium;
  return 0;
}

function spendBoost(spentMicro: bigint, weights: AttentionWeights): number {
  const threshold = BigInt(weights.spendAtRiskThresholdMicro);
  if (spentMicro >= threshold) return weights.spendAtRiskBoost;
  return 0;
}

function loopBoost(loopCount: number, weights: AttentionWeights): number {
  const raw = loopCount * weights.loopBoostPerCount;
  return Math.min(raw, weights.loopBoostCap);
}

function snoozePenalty(snoozedUntil: Date | null, now: Date, weights: AttentionWeights): number {
  if (!snoozedUntil) return 0;
  if (snoozedUntil.getTime() > now.getTime()) return weights.snoozePenalty;
  return 0;
}

export function computeAttentionScore(input: ScoreInput): ScoreBreakdown {
  const hoursOpen = Math.max(
    0,
    (input.now.getTime() - input.createdAt.getTime()) / (60 * 60 * 1000),
  );
  const base = input.weights.base[input.kind] ?? 0;
  const age = ageBoost(hoursOpen, input.weights);
  const complexity = complexityBoost(input.complexity, input.weights);
  const spend = spendBoost(input.spentMicroUsd, input.weights);
  const loop = loopBoost(input.loopCount, input.weights);
  const snooze = snoozePenalty(input.snoozedUntil, input.now, input.weights);
  const total = Math.round(base + age + complexity + spend + loop - snooze);
  return {
    base,
    ageBoost: age,
    complexityBoost: complexity,
    spendAtRiskBoost: spend,
    loopBoost: loop,
    snoozePenalty: snooze,
    total,
    weightsVersion: input.weights.version,
  };
}

export function describeScore(breakdown: ScoreBreakdown, kind: AttentionKind): string {
  const parts: string[] = [`${kind.replace(/_/g, ' ')} (${breakdown.base})`];
  if (breakdown.ageBoost > 0) {
    parts.push(`open time (+${breakdown.ageBoost})`);
  }
  if (breakdown.complexityBoost > 0) {
    parts.push(`complexity (+${breakdown.complexityBoost})`);
  }
  if (breakdown.spendAtRiskBoost > 0) {
    parts.push(`sunk spend (+${breakdown.spendAtRiskBoost})`);
  }
  if (breakdown.loopBoost > 0) {
    parts.push(`rework loops (+${breakdown.loopBoost})`);
  }
  if (breakdown.snoozePenalty > 0) {
    parts.push(`snoozed (−${breakdown.snoozePenalty})`);
  }
  return `Ranked because: ${parts.join(' + ')} = ${breakdown.total}.`;
}
