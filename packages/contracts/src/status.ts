import { z } from 'zod';

export const DerivedStatusSchema = z.enum([
  'idle',
  'ai_working',
  'needs_answer',
  'needs_approval',
  'blocked_external',
  'paused_budget',
  'failed_run',
  'abandoned',
  'archived',
]);

export type DerivedStatus = z.infer<typeof DerivedStatusSchema>;

export const StatusOverrideSchema = z.object({
  status: DerivedStatusSchema,
  reason: z.string().min(1),
});

export type StatusOverride = z.infer<typeof StatusOverrideSchema>;

export const StatusFactsSchema = z.object({
  activeRuns: z.number().int().nonnegative().default(0),
  openBlockingQuestions: z.number().int().nonnegative().default(0),
  failedRunsSinceLastSuccess: z.number().int().nonnegative().default(0),
  pendingApprovals: z.number().int().nonnegative().default(0),
  blockingGateResults: z.number().int().nonnegative().default(0),
  budgetState: z.enum(['ok', 'warn', 'blocked']).default('ok'),
  loopEscalated: z.boolean().default(false),
  override: StatusOverrideSchema.nullable().default(null),
});

export type StatusFacts = z.infer<typeof StatusFactsSchema>;
