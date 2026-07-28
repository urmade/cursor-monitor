import { z } from 'zod';

export const ArtifactRefSchema = z.object({
  kind: z.enum(['pr', 'branch', 'preview', 'artifact', 'link']),
  url: z.string().url().max(2_000),
  title: z.string().max(200).optional(),
});

export const ReportQuestionSchema = z.object({
  text: z.string().max(4_000),
  blocking: z.boolean().default(false),
  options: z.array(z.string().max(200)).max(10).default([]),
});

/** VISION.md §7 stage report — frozen for Phase 2 / consumed by Phase 3 gates. */
export const StageReportSchema = z.object({
  ticket_id: z.string().uuid(),
  stage: z.string().min(1).max(100),
  outcome: z.enum(['complete', 'partial', 'blocked', 'failed']),
  confidence: z.number().min(0).max(1).optional(),
  headline: z.string().min(1).max(200),
  summary: z.string().max(20_000).default(''),
  assumptions: z.array(z.string().max(1_000)).max(20).default([]),
  not_verified: z.array(z.string().max(1_000)).max(20).default([]),
  questions: z.array(ReportQuestionSchema).max(10).default([]),
  labels_to_set: z.array(z.string().max(100)).max(20).default([]),
  acceptance_criteria: z.array(z.string().max(1_000)).max(50).default([]),
  artifact_refs: z.array(ArtifactRefSchema).max(20).default([]),
});

export type StageReport = z.infer<typeof StageReportSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
