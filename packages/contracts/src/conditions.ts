import { z } from 'zod';
import { LoopBudgetConfigSchema } from './loops';

/**
 * Versioned Condition DSL (D11). Envelope is always `{ v: 1, ... }`.
 * No expression strings, no eval — a closed AST over a fixed field set.
 */

export const CONDITION_DSL_VERSION = 1 as const;

export const FieldRefSchema = z.enum([
  'ticket.complexity',
  'ticket.stage.key',
  'ticket.owner_class',
  'ticket.title',
  'spec.exists',
  'spec.acceptance_criteria.count',
  'report.outcome',
  'report.confidence',
  'report.not_verified.count',
  'report.assumptions.count',
  'run.status',
  'run.count_in_stage',
  'warnings.open.count',
  'warnings.open_in_current_stage.count',
  'loop.count',
  'loop.count_from_stage',
  'budget.item.spent_ratio',
  'budget.project.spent_ratio',
]);

export type FieldRef = z.infer<typeof FieldRefSchema>;

export const CountableRefSchema = z.enum([
  'spec.acceptance_criteria.count',
  'report.not_verified.count',
  'report.assumptions.count',
  'run.count_in_stage',
  'warnings.open.count',
  'warnings.open_in_current_stage.count',
  'loop.count',
  'loop.count_from_stage',
]);

export type CountableRef = z.infer<typeof CountableRefSchema>;

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;

type ConditionAstInternal =
  | { op: 'and' | 'or'; of: ConditionAstInternal[] }
  | { op: 'not'; of: ConditionAstInternal }
  | {
      op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
      field: FieldRef;
      value: JsonPrimitive;
    }
  | { op: 'in' | 'not_in'; field: FieldRef; values: JsonPrimitive[] }
  | { op: 'has_label' | 'lacks_label'; value: string }
  | { op: 'has_warning_code' | 'lacks_warning_code'; value: string }
  | { op: 'exists' | 'missing'; field: FieldRef }
  | { op: 'count_gte'; field: CountableRef; value: number };

export type ConditionAst = ConditionAstInternal;

export const ConditionAstSchema: z.ZodType<ConditionAst> = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(['and', 'or']),
      of: z.array(ConditionAstSchema).min(1).max(32),
    }),
    z.object({
      op: z.literal('not'),
      of: ConditionAstSchema,
    }),
    z.object({
      op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
      field: FieldRefSchema,
      value: JsonPrimitiveSchema,
    }),
    z.object({
      op: z.enum(['in', 'not_in']),
      field: FieldRefSchema,
      values: z.array(JsonPrimitiveSchema).min(1).max(64),
    }),
    z.object({
      op: z.enum(['has_label', 'lacks_label']),
      value: z.string().min(1).max(100),
    }),
    z.object({
      op: z.enum(['has_warning_code', 'lacks_warning_code']),
      value: z.string().min(1).max(100),
    }),
    z.object({
      op: z.enum(['exists', 'missing']),
      field: FieldRefSchema,
    }),
    z.object({
      op: z.literal('count_gte'),
      field: CountableRefSchema,
      value: z.number().int().nonnegative(),
    }),
  ]),
);

export const ConditionEnvelopeSchema = z.object({
  v: z.literal(CONDITION_DSL_VERSION),
  ast: ConditionAstSchema,
});

export type ConditionEnvelope = z.infer<typeof ConditionEnvelopeSchema>;

/** Max AST nesting depth accepted by CRUD / evaluator guards. */
export const CONDITION_MAX_DEPTH = 8;

export function conditionDepth(ast: ConditionAst, depth = 1): number {
  if (ast.op === 'and' || ast.op === 'or') {
    return Math.max(depth, ...ast.of.map((c) => conditionDepth(c, depth + 1)));
  }
  if (ast.op === 'not') {
    return conditionDepth(ast.of, depth + 1);
  }
  return depth;
}

export function wrapCondition(ast: ConditionAst): ConditionEnvelope {
  return { v: CONDITION_DSL_VERSION, ast };
}

export function unwrapCondition(
  value: unknown,
): ConditionAst | null {
  if (value == null) return null;
  const env = ConditionEnvelopeSchema.safeParse(value);
  if (env.success) return env.data.ast;
  // Bare AST (tests / internal)
  const bare = ConditionAstSchema.safeParse(value);
  if (bare.success) return bare.data;
  return null;
}

// ── Gate contracts ──────────────────────────────────────────────────────────

export const GateEvaluatorKindSchema = z.enum([
  'field_rule',
  'human_approval',
  'budget',
  'agentic',
  'loop_budget',
  'visual_confirmation',
]);
export type GateEvaluatorKind = z.infer<typeof GateEvaluatorKindSchema>;

export const GateTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('on_transition'),
    fromStageId: z.string().uuid().optional(),
    toStageId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('on_run_finished'),
    stageId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal('on_label_added'),
    labelKey: z.string().min(1).max(100),
  }),
  z.object({
    kind: z.literal('on_demand'),
  }),
]);
export type GateTrigger = z.infer<typeof GateTriggerSchema>;

export const FieldRuleConfigSchema = z.object({
  require: ConditionAstSchema,
  warnWhen: ConditionAstSchema.optional(),
  message: z.string().min(1).max(500),
  /** Stable warning code when on_failure=warn (default derived from gate name). */
  code: z.string().min(1).max(100).optional(),
});
export type FieldRuleConfig = z.infer<typeof FieldRuleConfigSchema>;

export const HumanApprovalConfigSchema = z.object({
  approverRoles: z
    .array(z.enum(['owner', 'maintainer', 'member', 'viewer']))
    .min(1)
    .default(['maintainer']),
  allowSelfApproval: z.boolean().default(false),
  instructions: z.string().max(2_000).default(''),
});
export type HumanApprovalConfig = z.infer<typeof HumanApprovalConfigSchema>;

/** Phase 4 fills this in; Phase 3 accepts the shape so stubs can store config. */
export const BudgetConfigSchema = z
  .object({
    scope: z.enum(['item', 'project']).default('item'),
    warnAtRatio: z.number().min(0).max(2).default(0.8),
    blockAtRatio: z.number().min(0).max(2).default(1),
    message: z.string().max(500).default(''),
    softRatio: z.number().min(0).max(2).optional(),
    hardRatio: z.number().min(0).max(2).optional(),
  })
  .passthrough();
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

/** Phase 7 agentic gate config. */
export const AgenticConfigSchema = z.object({
  rubricId: z.string().uuid(),
  warningCode: z.string().min(1).max(100).optional(),
  async: z.boolean().optional(),
});
export type AgenticConfig = z.infer<typeof AgenticConfigSchema>;

/** Visual confirmation gate — requires artifact refs of accepted kinds. */
export const VisualConfirmationConfigSchema = z.object({
  evidenceKinds: z
    .array(z.enum(['pr', 'branch', 'preview', 'artifact', 'link']))
    .min(1)
    .default(['preview', 'artifact']),
  requireApproval: z.boolean().default(false),
  message: z.string().max(500).default('Visual confirmation evidence required'),
  code: z.string().min(1).max(100).optional(),
});
export type VisualConfirmationConfig = z.infer<
  typeof VisualConfirmationConfigSchema
>;

export { LoopBudgetConfigSchema } from './loops';
export type { LoopBudgetConfig } from './loops';

export const GateConfigSchema = z.union([
  FieldRuleConfigSchema,
  HumanApprovalConfigSchema,
  BudgetConfigSchema,
  AgenticConfigSchema,
  LoopBudgetConfigSchema,
  VisualConfirmationConfigSchema,
]);
export type GateConfig = z.infer<typeof GateConfigSchema>;

export const GateOutcomeSchema = z.enum([
  'pass',
  'warn',
  'block',
  'skipped',
  'error',
]);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

export const BatchOutcomeSchema = z.enum(['pass', 'warn', 'block']);
export type BatchOutcome = z.infer<typeof BatchOutcomeSchema>;

export const EnforcementModeSchema = z.enum(['enforce', 'observe']);
export type EnforcementMode = z.infer<typeof EnforcementModeSchema>;

export const WarningStatusSchema = z.enum(['open', 'dismissed', 'resolved']);
export type WarningStatus = z.infer<typeof WarningStatusSchema>;

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'withdrawn',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const InterventionKindSchema = z.enum([
  'gate_override',
  'status_override',
  'warning_dismissed',
  'approval',
  'budget_raise',
  'run_killed',
  'answer',
]);
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

/** Caps enforced at gate creation / evaluation. */
export const GATES_PER_PROJECT_CAP = 40;
export const GATE_EVAL_PERF_BUDGET_MS = 150;
