import { eq } from 'drizzle-orm';
import { attentionItems, runs } from '@nexus/db';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { answerQuestion, withdrawQuestion } from '../questions';
import { decideApproval } from '../approvals';
import {
  setItemBudget,
  raiseProjectCap,
} from '../budgets/actions';
import { launchRun } from '../runs/lifecycle';
import { resolveAttentionBySource } from './projection';
import { getAttentionItem } from './list';
import { can } from '../authz/can';
import { interventions, newId, workItems } from '@nexus/db';
import { emit } from '../events/emit';
import { resumeAfterQuestion } from './resume';
import { listStages } from '../projects/stages';
import { transitionWorkItem, updateWorkItem } from '../workitems';

export type ActionResult = {
  attentionItemId: string;
  outcome: 'ok' | 'failed';
  detail?: Record<string, unknown>;
};

async function recordInboxIntervention(
  ctx: ServiceContext,
  input: {
    projectId: string;
    workItemId: string;
    action: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.insert(interventions).values({
    id: newId(),
    projectId: input.projectId,
    workItemId: input.workItemId,
    actor: ctx.actor as Record<string, unknown>,
    kind: 'inbox_action',
    target: { type: 'inbox', action: input.action },
    detail: input.detail,
  });
  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: input.projectId,
    type: 'intervention.recorded',
    subjectType: 'work_item',
    subjectId: input.workItemId,
    actor: ctx.actor,
    payload: { kind: 'inbox_action', action: input.action },
  });
}

export async function executeAction(
  ctx: ServiceContext,
  input: { attentionItemId: string; action: string; payload?: Record<string, unknown> },
): Promise<Result<ActionResult, CoreError>> {
  const row = await ctx.db.query.attentionItems.findFirst({
    where: eq(attentionItems.id, input.attentionItemId),
  });
  if (!row || row.status !== 'open') {
    return err(coreError('not_found', 'Attention item not found or already handled'));
  }

  const role = await getProjectRole(ctx, row.projectId);
  if (
    !can(ctx.actor, 'work_item.update', {
      type: 'work_item',
      projectId: row.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'You cannot perform this action'));
  }

  const payload = input.payload ?? {};
  const action = input.action;

  try {
    switch (row.kind) {
      case 'blocking_question': {
        if (action === 'answer') {
          const answer = String(payload.answer ?? '');
          if (!answer) return err(coreError('validation', 'Answer is required'));
          const result = await answerQuestion(ctx, row.sourceId, answer, { resume: false });
          if (!result.ok) return result;
          await resolveAttentionBySource(ctx, 'question', row.sourceId, 'answered');
          const resume = await resumeAfterQuestion(ctx, {
            questionId: row.sourceId,
            answer,
            workItemId: row.workItemId,
          });
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { resume },
          });
          return ok({
            attentionItemId: row.id,
            outcome: 'ok',
            detail: { resume },
          });
        }
        if (action === 'withdraw') {
          const result = await withdrawQuestion(ctx, row.sourceId);
          if (!result.ok) return result;
          await resolveAttentionBySource(ctx, 'question', row.sourceId, 'withdrawn');
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: {},
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        break;
      }
      case 'pending_approval': {
        if (action === 'approve' || action === 'reject') {
          const result = await decideApproval(ctx, row.sourceId, {
            decision: action === 'approve' ? 'approved' : 'rejected',
            comment: String(payload.comment ?? ''),
          });
          if (!result.ok) return result;
          await resolveAttentionBySource(ctx, 'approval', row.sourceId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: {},
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        break;
      }
      case 'budget_block': {
        if (action === 'raise_item_budget') {
          const micro = BigInt(String(payload.microUsd ?? '0'));
          const result = await setItemBudget(ctx, row.workItemId, {
            micro: micro,
            reason: String(payload.reason ?? 'Raised from inbox'),
          });
          if (!result.ok) return result;
          await resolveAttentionBySource(ctx, 'work_item_budget', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { microUsd: String(micro) },
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        if (action === 'raise_project_cap') {
          const micro = BigInt(String(payload.microUsd ?? '0'));
          const result = await raiseProjectCap(ctx, row.projectId, {
            micro: micro,
            reason: String(payload.reason ?? 'Raised from inbox'),
          });
          if (!result.ok) return result;
          await resolveAttentionBySource(ctx, 'work_item_budget', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: {},
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        if (action === 'pause_item') {
          await ctx.db
            .update(workItems)
            .set({ pausedReason: 'deliberate', updatedAt: ctx.clock() })
            .where(eq(workItems.id, row.workItemId));
          await resolveAttentionBySource(ctx, 'work_item_budget', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: {},
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        break;
      }
      case 'run_failed':
      case 'run_completed_no_report': {
        if (action === 'open_cursor') {
          const run = await ctx.db.query.runs.findFirst({
            where: eq(runs.id, row.sourceId),
          });
          if (!run?.providerUrl) {
            return err(coreError('not_found', 'No Cursor run URL for this failure'));
          }
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { url: run.providerUrl },
          });
          return ok({
            attentionItemId: row.id,
            outcome: 'ok',
            detail: { navigate: run.providerUrl },
          });
        }
        if (action === 'loop_return' && row.kind === 'run_failed') {
          const item = await ctx.db.query.workItems.findFirst({
            where: eq(workItems.id, row.workItemId),
          });
          if (!item) return err(coreError('not_found', 'Work item not found'));
          const stagesR = await listStages(ctx, row.projectId);
          if (!stagesR.ok) return stagesR;
          const ordered = [...stagesR.value].sort((a, b) => a.position - b.position);
          const currentIdx = ordered.findIndex((s) => s.id === item.currentStageId);
          const prior = currentIdx > 0 ? ordered[currentIdx - 1] : null;
          if (!prior) {
            return err(coreError('invalid_transition', 'No prior stage to return to'));
          }
          const moved = await transitionWorkItem(
            ctx,
            item.id,
            {
              kind: 'return',
              toStageId: prior.id,
              reasonCode: String(payload.reasonCode ?? 'review_findings'),
              note: String(payload.note ?? 'Returned from inbox after failed run'),
            },
            item.version,
          );
          if (!moved.ok) return moved;
          await resolveAttentionBySource(ctx, 'run', row.sourceId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { toStageId: prior.id },
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        if (action === 'retry_run') {
          const launch = await launchRun(ctx, {
            workItemId: row.workItemId,
            trigger: { kind: 'remediation', by: { fromInbox: true, priorRunId: row.sourceId } },
          });
          if (!launch.ok) return launch;
          await resolveAttentionBySource(ctx, 'run', row.sourceId, 'retry');
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { runId: launch.value.id },
          });
          return ok({
            attentionItemId: row.id,
            outcome: 'ok',
            detail: { runId: launch.value.id },
          });
        }
        if (action === 'accept_no_report') {
          await resolveAttentionBySource(ctx, 'run', row.sourceId, 'accepted_manual');
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: {},
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        break;
      }
      case 'external_block': {
        if (action === 'clear_external') {
          await ctx.db
            .update(workItems)
            .set({ pausedReason: null, updatedAt: ctx.clock() })
            .where(eq(workItems.id, row.workItemId));
          await resolveAttentionBySource(ctx, 'work_item_external', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: {},
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        break;
      }
      case 'loop_escalation': {
        if (action === 'change_complexity') {
          const item = await ctx.db.query.workItems.findFirst({
            where: eq(workItems.id, row.workItemId),
          });
          if (!item) return err(coreError('not_found', 'Work item not found'));
          const complexity = String(payload.complexity ?? 'high') as 'low' | 'medium' | 'high';
          const updated = await updateWorkItem(ctx, row.workItemId, { complexity }, item.version);
          if (!updated.ok) return updated;
          await resolveAttentionBySource(ctx, 'work_item_loop', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { complexity },
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        if (action === 'raise_item_budget') {
          const micro = BigInt(String(payload.microUsd ?? '15000000'));
          const result = await setItemBudget(ctx, row.workItemId, {
            micro,
            reason: String(payload.reason ?? 'Raised from inbox (loop escalation)'),
          });
          if (!result.ok) return result;
          await resolveAttentionBySource(ctx, 'work_item_loop', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { microUsd: String(micro) },
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        if (action === 'loop_return') {
          const item = await ctx.db.query.workItems.findFirst({
            where: eq(workItems.id, row.workItemId),
          });
          if (!item) return err(coreError('not_found', 'Work item not found'));
          const stagesR = await listStages(ctx, row.projectId);
          if (!stagesR.ok) return stagesR;
          const ordered = [...stagesR.value].sort((a, b) => a.position - b.position);
          const currentIdx = ordered.findIndex((s) => s.id === item.currentStageId);
          const prior = currentIdx > 0 ? ordered[currentIdx - 1] : null;
          if (!prior) {
            return err(coreError('invalid_transition', 'No prior stage to return to'));
          }
          const moved = await transitionWorkItem(ctx, item.id, {
            kind: 'return',
            toStageId: prior.id,
            reasonCode: String(payload.reasonCode ?? 'review_findings'),
            note: String(payload.note ?? 'Returned from inbox'),
          }, item.version);
          if (!moved.ok) return moved;
          await resolveAttentionBySource(ctx, 'work_item_loop', row.workItemId, action);
          await recordInboxIntervention(ctx, {
            projectId: row.projectId,
            workItemId: row.workItemId,
            action,
            detail: { toStageId: prior.id },
          });
          return ok({ attentionItemId: row.id, outcome: 'ok' });
        }
        break;
      }
      default:
        break;
    }
  } catch (e) {
    return err(
      coreError('invariant', e instanceof Error ? e.message : 'Action failed', {
        attentionItemId: row.id,
      }),
    );
  }

  if (action === 'open_ticket') {
    const item = await getAttentionItem(ctx, row.id);
    return ok({
      attentionItemId: row.id,
      outcome: 'ok',
      detail: { navigate: true, item: item.ok ? item.value : null },
    });
  }

  return err(coreError('validation', `Unknown action ${action} for kind ${row.kind}`));
}

export async function snoozeAttention(
  ctx: ServiceContext,
  id: string,
  until: Date,
  reason: string,
): Promise<Result<void, CoreError>> {
  const max = new Date(ctx.clock().getTime() + 24 * 60 * 60 * 1000);
  if (until.getTime() > max.getTime()) {
    return err(coreError('validation', 'Snooze capped at 24 hours'));
  }
  const row = await ctx.db.query.attentionItems.findFirst({
    where: eq(attentionItems.id, id),
  });
  if (!row || row.status !== 'open') {
    return err(coreError('not_found', 'Attention item not found'));
  }
  await ctx.db
    .update(attentionItems)
    .set({ snoozedUntil: until, resolution: reason })
    .where(eq(attentionItems.id, id));
  return ok(undefined);
}
