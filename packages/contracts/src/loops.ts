import { z } from 'zod';

/** Seeded default reason-code taxonomy (project-configurable). */
export const DEFAULT_LOOP_REASON_CODES = [
  {
    code: 'review_findings',
    label: 'Review findings',
    requiresNote: false,
    position: 0,
  },
  {
    code: 'spec_gap',
    label: 'Spec gap',
    requiresNote: false,
    position: 1,
  },
  {
    code: 'failed_verification',
    label: 'Failed verification',
    requiresNote: false,
    position: 2,
  },
  {
    code: 'changed_requirements',
    label: 'Changed requirements',
    requiresNote: false,
    position: 3,
  },
  {
    code: 'agent_error',
    label: 'Agent error',
    requiresNote: false,
    position: 4,
  },
  {
    code: 'human_direction',
    label: 'Human direction',
    requiresNote: false,
    position: 5,
  },
  {
    code: 'gate_block',
    label: 'Gate block',
    requiresNote: false,
    position: 6,
  },
  {
    code: 'gate_override',
    label: 'Gate override',
    requiresNote: false,
    position: 7,
  },
  {
    code: 'other',
    label: 'Other',
    requiresNote: true,
    position: 8,
  },
] as const;

export type DefaultLoopReasonCode =
  (typeof DEFAULT_LOOP_REASON_CODES)[number]['code'];

export const LoopTriggerSchema = z.object({
  kind: z.enum(['human', 'gate', 'report', 'backfill', 'system']),
  by: z.string().optional(),
  ref: z.string().optional(),
});
export type LoopTrigger = z.infer<typeof LoopTriggerSchema>;

export const LoopBudgetConfigSchema = z
  .object({
    scope: z.enum(['item', 'stage', 'stage_pair']).default('item'),
    stageId: z.string().uuid().optional(),
    fromStageId: z.string().uuid().optional(),
    toStageId: z.string().uuid().optional(),
    warnAt: z.number().int().min(1).default(2),
    escalateAt: z.number().int().min(1).default(3),
    blockAt: z.number().int().min(1).optional(),
    message: z.string().max(500).default('Loop budget exceeded'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.warnAt > cfg.escalateAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'warnAt must be <= escalateAt',
        path: ['warnAt'],
      });
    }
    if (cfg.blockAt != null && cfg.escalateAt > cfg.blockAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'escalateAt must be <= blockAt',
        path: ['escalateAt'],
      });
    }
  });
export type LoopBudgetConfig = z.infer<typeof LoopBudgetConfigSchema>;

export const LoopEdgeSummarySchema = z.object({
  id: z.string().uuid(),
  fromStageId: z.string().uuid(),
  toStageId: z.string().uuid(),
  reasonCode: z.string(),
  note: z.string().nullable(),
  trigger: LoopTriggerSchema,
  occurredAt: z.string(),
  closedAt: z.string().nullable(),
  costMicroUsd: z.string().nullable(),
  durationMs: z.string().nullable(),
  costComplete: z.boolean(),
});
export type LoopEdgeSummary = z.infer<typeof LoopEdgeSummarySchema>;

/**
 * Pure loop-budget threshold resolution — shared by the evaluator and tests.
 * Mutating this to use `>` instead of `>=` must fail unit tests.
 */
export function resolveLoopBudgetOutcome(input: {
  count: number;
  warnAt: number;
  escalateAt: number;
  blockAt?: number;
}): 'pass' | 'warn' | 'escalate' | 'block' {
  if (input.blockAt != null && input.count >= input.blockAt) return 'block';
  if (input.count >= input.escalateAt) return 'escalate';
  if (input.count >= input.warnAt) return 'warn';
  return 'pass';
}

/**
 * Derive the count a loop_budget gate should measure from stored edges plus
 * an optional pending return. Uses the gate's configured stage / pair, not
 * whichever transition happens to be in flight.
 */
export function countForLoopBudgetScope(input: {
  scope: 'item' | 'stage' | 'stage_pair';
  itemLoopCount: number;
  edges: Array<{ fromStageId: string; toStageId: string }>;
  stageId?: string;
  fromStageId?: string;
  toStageId?: string;
  prospectiveReturn?: { fromStageId: string; toStageId: string } | null;
}): number {
  const prospective = input.prospectiveReturn ?? null;
  if (input.scope === 'item') {
    return input.itemLoopCount + (prospective ? 1 : 0);
  }
  if (input.scope === 'stage') {
    const stageId = input.stageId ?? prospective?.toStageId;
    if (!stageId) return input.itemLoopCount + (prospective ? 1 : 0);
    let n = input.edges.filter((e) => e.toStageId === stageId).length;
    if (prospective && prospective.toStageId === stageId) n += 1;
    return n;
  }
  // stage_pair
  const fromId = input.fromStageId ?? prospective?.fromStageId;
  const toId = input.toStageId ?? prospective?.toStageId;
  if (!fromId || !toId) return input.itemLoopCount + (prospective ? 1 : 0);
  let n = input.edges.filter(
    (e) => e.fromStageId === fromId && e.toStageId === toId,
  ).length;
  if (
    prospective &&
    prospective.fromStageId === fromId &&
    prospective.toStageId === toId
  ) {
    n += 1;
  }
  return n;
}
