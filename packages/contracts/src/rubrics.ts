import { z } from 'zod';

export const RubricTargetSchema = z.enum(['spec', 'stage_report']);
export type RubricTarget = z.infer<typeof RubricTargetSchema>;

export const RubricCriterionWeightSchema = z.enum(['must', 'should']);
export type RubricCriterionWeight = z.infer<typeof RubricCriterionWeightSchema>;

export const RubricCriterionSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/, 'criterion key must be snake_case'),
  statement: z.string().min(1).max(500),
  weight: RubricCriterionWeightSchema,
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const UncertaintyPolicySchema = z.enum(['warn', 'pass', 'block']);
export type UncertaintyPolicy = z.infer<typeof UncertaintyPolicySchema>;

export const RubricCriteriaSchema = z
  .array(RubricCriterionSchema)
  .min(1)
  .max(20);
export type RubricCriteria = z.infer<typeof RubricCriteriaSchema>;

/** Authoring input — version assigned on write. */
export const CreateRubricInputSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  target: RubricTargetSchema,
  question: z.string().min(1).max(500),
  criteria: RubricCriteriaSchema,
  passWhen: z.string().min(1).max(1_000),
  blockWhen: z.string().min(1).max(1_000),
  guidance: z.string().max(5_000).default(''),
  model: z.string().min(1).max(100).default('gpt-4o-mini'),
  maxOutputTokens: z.number().int().min(200).max(4_000).default(1_200),
  uncertaintyPolicy: UncertaintyPolicySchema.default('warn'),
});
export type CreateRubricInput = z.infer<typeof CreateRubricInputSchema>;

export const UpdateRubricInputSchema = CreateRubricInputSchema.omit({
  projectId: true,
}).partial().extend({
  rubricId: z.string().uuid(),
});
export type UpdateRubricInput = z.infer<typeof UpdateRubricInputSchema>;

export const CriterionMetSchema = z.enum(['yes', 'no', 'unclear']);
export type CriterionMet = z.infer<typeof CriterionMetSchema>;

export const RubricCriterionVerdictSchema = z
  .object({
    key: z.string().min(1).max(80),
    met: CriterionMetSchema,
    reason: z.string().max(500),
    evidence: z.string().max(500),
  })
  .superRefine((val, ctx) => {
    if (val.met === 'no' && val.evidence.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evidence quotation required when met=no',
        path: ['evidence'],
      });
    }
  });
export type RubricCriterionVerdict = z.infer<typeof RubricCriterionVerdictSchema>;

export const RubricVerdictSchema = z.object({
  outcome: z.enum(['pass', 'warn', 'block']),
  confidence: z.number().min(0).max(1),
  headline: z.string().min(1).max(200),
  criteria: z.array(RubricCriterionVerdictSchema).min(1).max(20),
  suggested_remediation: z.string().max(1_000).optional(),
});
export type RubricVerdict = z.infer<typeof RubricVerdictSchema>;

export const RubricTokensSchema = z.object({
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
export type RubricTokens = z.infer<typeof RubricTokensSchema>;

export const GoldenCaseExpectedSchema = z.enum(['pass', 'warn', 'block']);
export type GoldenCaseExpected = z.infer<typeof GoldenCaseExpectedSchema>;

export const AddGoldenCaseInputSchema = z.object({
  rubricId: z.string().uuid(),
  fromVerdictId: z.string().uuid().optional(),
  label: z.string().min(1).max(200),
  content: z.record(z.string(), z.unknown()).optional(),
  expectedOutcome: GoldenCaseExpectedSchema,
  note: z.string().max(2_000).optional(),
});
export type AddGoldenCaseInput = z.infer<typeof AddGoldenCaseInputSchema>;

/** Agentic gate config — Phase 7 fills the stub shape. */
export const AgenticGateConfigSchema = z.object({
  rubricId: z.string().uuid(),
  /** Stable warning code when outcome is warn (default derived from rubric name). */
  warningCode: z.string().min(1).max(100).optional(),
  /** Prefer async job + awaiting_evaluation (default false = sync with timeout). */
  async: z.boolean().optional(),
});
export type AgenticGateConfig = z.infer<typeof AgenticGateConfigSchema>;

export const CONFIDENCE_UNCERTAIN_THRESHOLD = 0.6;
export const RUBRIC_EVAL_TIMEOUT_MS = 20_000;
export const RUBRIC_EVAL_HOURLY_CAP = 60;
export const RUBRIC_CIRCUIT_FAILURES = 3;
export const RUBRIC_CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;
export const RAW_RESPONSE_RETENTION_DAYS = 30;
export const DEFAULT_REMEDIATION_MAX_ATTEMPTS = 2;
