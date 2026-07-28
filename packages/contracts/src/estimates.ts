import { z } from 'zod';

export const EstimateTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type EstimateTier = z.infer<typeof EstimateTierSchema>;

export const EstimateSourceMixSchema = z.enum([
  'reconciled',
  'estimated',
  'mixed',
]);
export type EstimateSourceMix = z.infer<typeof EstimateSourceMixSchema>;

const MicroUsdStringSchema = z.string().regex(/^-?\d+$/);

export const CostEstimateRangeSchema = z.object({
  kind: z.literal('range'),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  n: z.number().int().positive(),
  p50MicroUsd: MicroUsdStringSchema,
  p90MicroUsd: MicroUsdStringSchema,
  lowMicroUsd: MicroUsdStringSchema,
  basis: z.string().min(1),
  computedAt: z.string().datetime(),
  sourceMix: EstimateSourceMixSchema,
  p50DurationMs: z.number().int().nonnegative().optional(),
  p90DurationMs: z.number().int().nonnegative().optional(),
});

export const CostEstimateColdStartSchema = z.object({
  kind: z.literal('cold_start'),
  defaultBudgetMicroUsd: MicroUsdStringSchema,
  n: z.number().int().nonnegative(),
  reason: z.enum(['insufficient_history', 'flag_disabled']),
  basis: z.string().min(1),
  tier: z.literal(4),
  complexity: z.enum(['low', 'medium', 'high']),
});

export const CostEstimateSchema = z.discriminatedUnion('kind', [
  CostEstimateRangeSchema,
  CostEstimateColdStartSchema,
]);
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

export const BacktestBreakdownSchema = z.object({
  n: z.number().int().nonnegative(),
  coverage: z.number(),
  p50Bias: z.number().nullable(),
  mape: z.number().nullable(),
});

export const BacktestResultSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  ranAt: z.string().datetime(),
  sampleSize: z.number().int().nonnegative(),
  coverage: z.number(),
  p50Bias: z.number().nullable(),
  mape: z.number().nullable(),
  byComplexity: z.record(BacktestBreakdownSchema),
  byTier: z.record(BacktestBreakdownSchema),
  interpretation: z.string(),
});
export type BacktestResult = z.infer<typeof BacktestResultSchema>;
