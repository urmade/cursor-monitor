import { z } from 'zod';

const StageRefV1 = z.object({
  key: z.string(),
  name: z.string().optional(),
});

const WorkItemCreatedV1 = z.object({
  key: z.string(),
  title: z.string(),
  complexity: z.string().nullable().optional(),
});

const WorkItemUpdatedV1 = z.object({
  key: z.string(),
  title: z.string().optional(),
  complexity: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
});

const StageChangedV1 = z.object({
  from: StageRefV1.nullable(),
  to: StageRefV1,
  direction: z.enum(['forward', 'backward', 'lateral', 'initial']),
  reason_code: z.string().nullable().optional(),
});

const StatusChangedV1 = z.object({
  key: z.string(),
  from: z.string().nullable(),
  to: z.string(),
});

const SpecVersionCreatedV1 = z.object({
  version: z.number().int().positive(),
  content_hash: z.string().optional(),
});

const RunStartedV1 = z.object({
  run_id: z.string().uuid(),
  stage_key: z.string().optional(),
});

const RunFinishedV1 = z.object({
  run_id: z.string().uuid(),
  outcome: z.string(),
  stage_key: z.string().optional(),
});

const StageReportPostedV1 = z.object({
  run_id: z.string().uuid().optional(),
  stage_key: z.string().optional(),
  report_id: z.string().uuid().optional(),
});

const QuestionAskedV1 = z.object({
  question_id: z.string().uuid(),
  text: z.string(),
  blocking: z.boolean().optional(),
});

const QuestionAnsweredV1 = z.object({
  question_id: z.string().uuid(),
  answer: z.string().optional(),
});

const GateEvaluatedV1 = z.object({
  gate_id: z.string().uuid().optional(),
  gate_key: z.string().optional(),
  outcome: z.string(),
  batch_id: z.string().uuid().optional(),
});

const ApprovalDecidedV1 = z.object({
  approval_id: z.string().uuid().optional(),
  decision: z.enum(['approved', 'rejected']),
  gate_id: z.string().uuid().optional(),
});

const BudgetThresholdV1 = z.object({
  scope: z.enum(['item', 'project']),
  threshold: z.string(),
  ratio: z.number().optional(),
});

const BudgetBlockedV1 = z.object({
  work_item_id: z.string().uuid().optional(),
  reason: z.string().optional(),
});

const LoopDetectedV1 = z.object({
  loop_edge_id: z.string().uuid().optional(),
  reason_code: z.string().optional(),
});

const LoopEscalatedV1 = z.object({
  loop_edge_id: z.string().uuid().optional(),
  reason_code: z.string().optional(),
});

export const PUBLIC_EVENT_TYPES = [
  'work_item.created',
  'work_item.updated',
  'work_item.stage_changed',
  'work_item.status_changed',
  'spec.version_created',
  'run.started',
  'run.finished',
  'stage_report.posted',
  'question.asked',
  'question.answered',
  'gate.evaluated',
  'approval.decided',
  'budget.threshold_crossed',
  'budget.blocked',
  'loop.detected',
  'loop.escalated',
] as const;

export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

export const PUBLIC_EVENTS = {
  'work_item.created': { version: 1, schema: WorkItemCreatedV1 },
  'work_item.updated': { version: 1, schema: WorkItemUpdatedV1 },
  'work_item.stage_changed': { version: 1, schema: StageChangedV1 },
  'work_item.status_changed': { version: 1, schema: StatusChangedV1 },
  'spec.version_created': { version: 1, schema: SpecVersionCreatedV1 },
  'run.started': { version: 1, schema: RunStartedV1 },
  'run.finished': { version: 1, schema: RunFinishedV1 },
  'stage_report.posted': { version: 1, schema: StageReportPostedV1 },
  'question.asked': { version: 1, schema: QuestionAskedV1 },
  'question.answered': { version: 1, schema: QuestionAnsweredV1 },
  'gate.evaluated': { version: 1, schema: GateEvaluatedV1 },
  'approval.decided': { version: 1, schema: ApprovalDecidedV1 },
  'budget.threshold_crossed': { version: 1, schema: BudgetThresholdV1 },
  'budget.blocked': { version: 1, schema: BudgetBlockedV1 },
  'loop.detected': { version: 1, schema: LoopDetectedV1 },
  'loop.escalated': { version: 1, schema: LoopEscalatedV1 },
} as const;

export { zodSchemaFingerprint } from './schema-fingerprint';

/** Map internal outbox types to frozen public catalogue names. */
const INTERNAL_TO_PUBLIC: Record<string, PublicEventType> = {
  'approval.approved': 'approval.decided',
  'approval.rejected': 'approval.decided',
};

export function resolvePublicEventType(internalType: string): PublicEventType | null {
  if (internalType in PUBLIC_EVENTS) {
    return internalType as PublicEventType;
  }
  return INTERNAL_TO_PUBLIC[internalType] ?? null;
}

export function publicPayloadSchema(type: PublicEventType) {
  return PUBLIC_EVENTS[type].schema;
}

export const PublicWebhookEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  version: z.number().int(),
  occurred_at: z.string(),
  project: z.object({ id: z.string(), key: z.string() }),
  subject: z.object({
    type: z.string(),
    id: z.string(),
    key: z.string().optional(),
  }),
  actor: z.record(z.string(), z.unknown()),
  data: z.record(z.string(), z.unknown()),
  truncated: z.boolean().optional(),
  full_object_url: z.string().url().optional(),
});

export type PublicWebhookEnvelope = z.infer<typeof PublicWebhookEnvelopeSchema>;
