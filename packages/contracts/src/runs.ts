import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'pending',
  'launched',
  'running',
  'completed',
  'completed_no_report',
  'failed',
  'cancelled',
  'expired',
  'launch_failed',
  'abandoned',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ACTIVE_RUN_STATUSES = ['pending', 'launched', 'running'] as const;

export const TERMINAL_RUN_STATUSES = [
  'completed',
  'completed_no_report',
  'failed',
  'cancelled',
  'expired',
  'launch_failed',
  'abandoned',
] as const;

export const RunAdapterSchema = z.enum(['cloud_agent', 'automation_webhook']);
export type RunAdapter = z.infer<typeof RunAdapterSchema>;

export const RunTriggerSchema = z.object({
  kind: z.enum(['manual', 'transition', 'resume', 'remediation']),
  by: z.record(z.string(), z.unknown()).optional(),
});

export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunTokensSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheWrite: z.number().optional(),
  cacheRead: z.number().optional(),
  total: z.number().optional(),
  chargedCents: z.number().optional(),
  rawCostCents: z.number().optional(),
});

export type RunTokens = z.infer<typeof RunTokensSchema>;

export const CloudAgentBindingConfigSchema = z.object({
  adapter: z.literal('cloud_agent'),
  repoUrl: z.string().url().optional(),
  startingRef: z.string().default('main'),
  model: z.string().optional(),
  promptTemplateId: z.string().uuid().optional(),
  autoCreatePR: z.boolean().default(false),
  maxDurationMinutes: z.number().int().positive().default(60),
  /** When true, create a no-repo agent (Phase 0 proven path / demo). */
  noRepo: z.boolean().default(false),
});

export const AutomationWebhookBindingConfigSchema = z.object({
  adapter: z.literal('automation_webhook'),
  webhookUrlSecretKey: z.string().min(1),
  automationId: z.string().optional(),
  maxDurationMinutes: z.number().int().positive().default(60),
});

export const BindingConfigSchema = z.discriminatedUnion('adapter', [
  CloudAgentBindingConfigSchema,
  AutomationWebhookBindingConfigSchema,
]);

export type BindingConfig = z.infer<typeof BindingConfigSchema>;

/** Legacy Phase 2 binding filters (still accepted). */
export const LegacyBindingConditionSchema = z.object({
  labelKeysAny: z.array(z.string()).optional(),
  labelKeysAll: z.array(z.string()).optional(),
  complexity: z.array(z.enum(['low', 'medium', 'high'])).optional(),
});

/**
 * Binding conditions: null = always; Phase 2 legacy filters; or Phase 3 DSL envelope.
 * Envelope branch MUST come first — LegacyBindingConditionSchema has every field optional
 * and would otherwise match `{ v: 1, ast }` and strip it to `{}`.
 * AST is validated at evaluate time (avoids circular import with conditions.ts).
 */
export const BindingDslEnvelopeSchema = z
  .object({
    v: z.literal(1),
    ast: z.unknown(),
  })
  .strict();

export const BindingConditionSchema = z
  .union([BindingDslEnvelopeSchema, LegacyBindingConditionSchema])
  .nullable();

export type BindingCondition = z.infer<typeof BindingConditionSchema>;
