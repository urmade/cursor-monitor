import { z } from 'zod';

/** Spec content — summary required; acceptance criteria optional until project opts in (P7). */
export const SpecContentSchema = z.object({
  summary: z.string().max(20_000).default(''),
  context: z.string().max(20_000).optional(),
  approach: z.string().max(20_000).optional(),
  acceptanceCriteria: z.array(z.string().max(1_000)).optional(),
  openQuestions: z.array(z.string().max(1_000)).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export type SpecContent = z.infer<typeof SpecContentSchema>;
