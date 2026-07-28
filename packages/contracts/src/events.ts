import { z } from 'zod';
import { ActorSchema } from './actor';

export const EventTypeSchema = z.enum([
  'org.created',
  'project.created',
  'project.updated',
  'stage.created',
  'stage.updated',
  'stage.archived',
  'label.created',
  'label.updated',
  'label.archived',
  'work_item.created',
  'work_item.updated',
  'work_item.archived',
  'work_item.stage_changed',
  'spec.version_created',
  'member.added',
  'member.role_changed',
  'member.removed',
  'status.override_set',
  'status.override_cleared',
  // Phase 2
  'binding.created',
  'binding.updated',
  'binding.archived',
  'prompt_template.created',
  'run.launched',
  'run.started',
  'run.finished',
  'run.failed',
  'run.cancelled',
  'run.expired',
  'run.completed_without_report',
  'run.launch_failed',
  'stage_report.posted',
  'question.asked',
  'question.answered',
  'question.withdrawn',
  'artifact_ref.attached',
  'label.agent_set',
  // Phase 3
  'gate.created',
  'gate.updated',
  'gate.archived',
  'gate.evaluated',
  'gate.blocked',
  'gate.warned',
  'warning.created',
  'warning.resolved',
  'warning.dismissed',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.withdrawn',
  'intervention.recorded',
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const NewEventSchema = z.object({
  orgId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  type: EventTypeSchema,
  subjectType: z.string().min(1),
  subjectId: z.string().uuid(),
  actor: ActorSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.date().optional(),
});

export type NewEvent = z.infer<typeof NewEventSchema>;
