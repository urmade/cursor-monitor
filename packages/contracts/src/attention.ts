import { z } from 'zod';
import { ActorSchema } from './actor';

export const AttentionKindSchema = z.enum([
  'blocking_question',
  'pending_approval',
  'budget_block',
  'run_failed',
  'run_completed_no_report',
  'loop_escalation',
  'external_block',
]);

export type AttentionKind = z.infer<typeof AttentionKindSchema>;

export const AttentionStatusSchema = z.enum(['open', 'resolved', 'dismissed']);
export type AttentionStatus = z.infer<typeof AttentionStatusSchema>;

export const AskedOfSchema = z.enum(['anyone', 'maintainer', 'owner']);
export type AskedOf = z.infer<typeof AskedOfSchema>;

export const ScoreBreakdownSchema = z.object({
  base: z.number(),
  ageBoost: z.number(),
  complexityBoost: z.number(),
  spendAtRiskBoost: z.number(),
  loopBoost: z.number(),
  snoozePenalty: z.number(),
  total: z.number(),
  weightsVersion: z.string().optional(),
});

export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const AttentionActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  requiresConfirm: z.boolean().default(false),
  payloadSchema: z.record(z.string(), z.unknown()).optional(),
});

export type AttentionAction = z.infer<typeof AttentionActionSchema>;

export const AttentionItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workItemId: z.string().uuid(),
  workItemKey: z.string().optional(),
  kind: AttentionKindSchema,
  sourceType: z.string(),
  sourceId: z.string().uuid(),
  title: z.string(),
  why: z.string(),
  askedOf: AskedOfSchema,
  status: AttentionStatusSchema,
  score: z.number(),
  scoreExplain: ScoreBreakdownSchema,
  actions: z.array(AttentionActionSchema),
  snoozedUntil: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  resolvedAt: z.coerce.date().nullable(),
  resolvedBy: ActorSchema.nullable().optional(),
  resolution: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type AttentionItemDto = z.infer<typeof AttentionItemSchema>;

export const AttentionWeightsSchema = z.object({
  version: z.string().default('1'),
  base: z.record(AttentionKindSchema, z.number()),
  ageLogCapHours: z.number().default(72),
  ageLogMultiplier: z.number().default(3),
  complexityHigh: z.number().default(10),
  complexityMedium: z.number().default(5),
  spendAtRiskThresholdMicro: z.string().default('5000000'),
  spendAtRiskBoost: z.number().default(8),
  loopBoostPerCount: z.number().default(4),
  loopBoostCap: z.number().default(20),
  snoozePenalty: z.number().default(50),
});

export type AttentionWeights = z.infer<typeof AttentionWeightsSchema>;

export const DEFAULT_ATTENTION_WEIGHTS: AttentionWeights = {
  version: '1',
  base: {
    blocking_question: 100,
    budget_block: 90,
    run_failed: 80,
    run_completed_no_report: 80,
    pending_approval: 70,
    loop_escalation: 60,
    external_block: 40,
  },
  ageLogCapHours: 72,
  ageLogMultiplier: 3,
  complexityHigh: 10,
  complexityMedium: 5,
  spendAtRiskThresholdMicro: '5000000',
  spendAtRiskBoost: 8,
  loopBoostPerCount: 4,
  loopBoostCap: 20,
  snoozePenalty: 50,
};

export const ExecuteAttentionActionSchema = z.object({
  attentionItemId: z.string().uuid(),
  action: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ExecuteAttentionAction = z.infer<typeof ExecuteAttentionActionSchema>;

export const InFlightSummarySchema = z.object({
  itemsInFlight: z.number(),
  oldestRunMinutes: z.number().nullable(),
  activeRunCount: z.number(),
  lastHumanAttentionAt: z.coerce.date().nullable(),
});

export type InFlightSummary = z.infer<typeof InFlightSummarySchema>;
