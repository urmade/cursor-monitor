import { z } from 'zod';
import { SpecContentSchema } from '../spec';
import { StageReportSchema } from './stage-report';

export const GetTicketArgsSchema = z.object({
  ticket_id: z.string().uuid(),
});

export const GetSpecArgsSchema = z.object({
  ticket_id: z.string().uuid(),
  version: z.number().int().positive().optional(),
});

export const UpdateSpecArgsSchema = z.object({
  ticket_id: z.string().uuid(),
  content: SpecContentSchema,
  mode: z.enum(['merge', 'replace']).default('merge'),
  base_version: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

export const PostStageReportArgsSchema = StageReportSchema;

export const SetLabelsArgsSchema = z.object({
  ticket_id: z.string().uuid(),
  add: z.array(z.string().max(100)).max(20).default([]),
  remove: z.array(z.string().max(100)).max(20).default([]),
});

export const AskQuestionArgsSchema = z.object({
  ticket_id: z.string().uuid(),
  text: z.string().min(1).max(4_000),
  blocking: z.boolean().default(false),
  options: z.array(z.string().max(200)).max(10).default([]),
});

export const AttachArtifactRefArgsSchema = z.object({
  ticket_id: z.string().uuid(),
  kind: z.enum(['pr', 'branch', 'preview', 'artifact', 'link']),
  url: z.string().url().max(2_000),
  title: z.string().max(200).optional(),
});

export const GetGateContextArgsSchema = z.object({
  ticket_id: z.string().uuid(),
});

export const ListQuestionsArgsSchema = z.object({
  ticket_id: z.string().uuid(),
});

export const MCP_TOOL_NAMES = [
  'get_ticket',
  'get_spec',
  'update_spec',
  'post_stage_report',
  'set_labels',
  'ask_question',
  'attach_artifact_ref',
  'get_gate_context',
  'list_questions',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_LIMITS = {
  specBytes: 100_000,
  reportSummaryChars: 20_000,
  questionChars: 4_000,
  labelsPerCall: 20,
  artifactRefsPerRun: 20,
  listQuestionsLimit: 50,
} as const;
