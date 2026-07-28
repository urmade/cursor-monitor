import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  HumanApprovalConfigSchema,
  type GateTrigger,
  type ProjectRole,
} from '@nexus/contracts';
import {
  approvals,
  gates,
  interventions,
  newId,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { evaluateGates, parseRequestedFor } from '../gates/evaluate';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export type Approval = typeof approvals.$inferSelect;

export const STALE_APPROVAL_MS = 48 * 60 * 60 * 1000;

export type PendingApprovalView = Approval & { stale: boolean };

export function isApprovalStale(
  requestedAt: Date,
  nowMs = Date.now(),
): boolean {
  return nowMs - new Date(requestedAt).getTime() > STALE_APPROVAL_MS;
}

export function canDecideApproval(input: {
  actorRole: ProjectRole | null;
  approverRoles: ProjectRole[];
  allowSelfApproval: boolean;
  requesterUserId: string | null;
  actorUserId: string | null;
}): boolean {
  if (!input.actorRole) return false;
  // Exact membership in approverRoles (not rank). Owner is always an implicit
  // approver — owners can override gates anyway (ADR-0009 / phase §13).
  const roleOk =
    input.actorRole === 'owner' ||
    input.approverRoles.includes(input.actorRole);
  if (!roleOk) return false;
  if (
    !input.allowSelfApproval &&
    input.requesterUserId &&
    input.actorUserId &&
    input.requesterUserId === input.actorUserId
  ) {
    return false;
  }
  return true;
}

/**
 * Pure read of pending approvals. Surfaces `stale` when older than 48h;
 * does not mutate rows (plan §10 — surface, don't auto-withdraw on SSR).
 */
export async function listPendingApprovals(
  ctx: ServiceContext,
  opts: { projectId: string },
): Promise<Result<PendingApprovalView[], CoreError>> {
  const role = await getProjectRole(ctx, opts.projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId: opts.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }

  const items = await ctx.db.query.workItems.findMany({
    where: eq(workItems.projectId, opts.projectId),
  });
  if (items.length === 0) return ok([]);
  const ids = items.map((i) => i.id);
  const rows = await ctx.db.query.approvals.findMany({
    where: and(
      inArray(approvals.workItemId, ids),
      eq(approvals.status, 'pending'),
    ),
    orderBy: [desc(approvals.requestedAt)],
  });

  const now = Date.now();
  return ok(
    rows.map((row) => ({
      ...row,
      stale: isApprovalStale(row.requestedAt, now),
    })),
  );
}

export async function listPendingApprovalsForItem(
  ctx: ServiceContext,
  workItemId: string,
) {
  return ctx.db.query.approvals.findMany({
    where: and(
      eq(approvals.workItemId, workItemId),
      eq(approvals.status, 'pending'),
    ),
    orderBy: [desc(approvals.requestedAt)],
  });
}

export async function decideApproval(
  ctx: ServiceContext,
  approvalId: string,
  input: { decision: 'approved' | 'rejected'; comment?: string },
): Promise<
  Result<
    {
      approval: Approval;
      transitionCompleted?: boolean;
      transitionError?: string;
      wasStale?: boolean;
    },
    CoreError
  >
> {
  const approval = await ctx.db.query.approvals.findFirst({
    where: eq(approvals.id, approvalId),
  });
  if (!approval || approval.status !== 'pending') {
    return err(coreError('not_found', 'Pending approval not found'));
  }

  // Stale approvals remain decidable — listing surfaces the flag; a background
  // sweep (not yet shipped) may withdraw later. Do not hard-reject on age.
  const wasStale = isApprovalStale(approval.requestedAt);

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, approval.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const gate = await ctx.db.query.gates.findFirst({
    where: eq(gates.id, approval.gateId),
  });
  if (!gate) return err(coreError('not_found', 'Gate not found'));

  const config = HumanApprovalConfigSchema.parse(gate.config);
  const role = await getProjectRole(ctx, item.projectId);

  if (
    !can(ctx.actor, 'approval.decide', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Not permitted to decide this approval'));
  }

  const parsed = parseRequestedFor(approval.requestedFor);
  const requesterUserId = parsed?.requesterUserId ?? null;

  if (ctx.actor.kind !== 'human') {
    return err(coreError('forbidden', 'Only humans may decide approvals'));
  }

  if (
    !canDecideApproval({
      actorRole: role,
      approverRoles: config.approverRoles,
      allowSelfApproval: config.allowSelfApproval,
      requesterUserId,
      actorUserId: ctx.actor.userId,
    })
  ) {
    return err(coreError('forbidden', 'Not permitted to decide this approval'));
  }

  const [updated] = await ctx.db
    .update(approvals)
    .set({
      status: input.decision,
      decidedByUserId: ctx.actor.userId,
      decidedAt: new Date(),
      comment: input.comment ?? null,
    })
    .where(eq(approvals.id, approvalId))
    .returning();

  await ctx.db.insert(interventions).values({
    id: newId(),
    workItemId: item.id,
    projectId: item.projectId,
    kind: 'approval',
    actor: ctx.actor,
    target: { approvalId, gateId: gate.id },
    detail: {
      decision: input.decision,
      comment: input.comment ?? null,
      wasStale,
    },
  });

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: input.decision === 'approved' ? 'approval.approved' : 'approval.rejected',
    subjectType: 'approval',
    subjectId: approvalId,
    actor: ctx.actor,
    payload: {
      comment: input.comment ?? null,
      gateId: gate.id,
      wasStale,
    },
  });

  let transitionCompleted = false;
  let transitionError: string | undefined;

  if (input.decision === 'approved') {
    const trigger = (parsed?.trigger ??
      (approval.requestedFor as GateTrigger)) as GateTrigger;
    if (trigger.kind === 'on_transition' && trigger.toStageId) {
      const batch = await evaluateGates(ctx, {
        workItemId: item.id,
        trigger,
      });
      if (batch.ok && batch.value.outcome !== 'block') {
        const { transitionWorkItemAfterGates } = await import(
          '../workitems/transition'
        );
        const result = await transitionWorkItemAfterGates(
          ctx,
          item.id,
          {
            toStageId: trigger.toStageId,
            note: `Completed after approval of gate "${gate.name}"`,
          },
          item.version,
          {
            gateBatchId: batch.value.batchId,
            gateEvaluationId: batch.value.evaluationIds[0],
          },
        );
        if (result.ok) {
          transitionCompleted = true;
        } else {
          transitionError = result.error.message;
        }
      } else if (batch.ok) {
        transitionError = `Still blocked: ${batch.value.blockedBy.map((b) => b.reason).join('; ')}`;
      } else {
        transitionError = batch.error.message;
      }
    }
  }

  return ok({
    approval: updated!,
    transitionCompleted,
    transitionError,
    wasStale,
  });
}

async function withdrawApprovalInternal(
  ctx: ServiceContext,
  approval: Approval,
  reason: string,
): Promise<void> {
  await ctx.db
    .update(approvals)
    .set({
      status: 'withdrawn',
      decidedAt: new Date(),
    })
    .where(eq(approvals.id, approval.id));
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, approval.workItemId),
  });
  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item?.projectId ?? null,
    type: 'approval.withdrawn',
    subjectType: 'approval',
    subjectId: approval.id,
    actor: ctx.actor,
    payload: { reason },
  });
}

/**
 * Withdraw pending approvals when the item moves elsewhere.
 * Not a public mutation surface — used internally by transitions.
 */
export async function withdrawPendingApprovals(
  ctx: ServiceContext,
  workItemId: string,
  reason: string,
): Promise<void> {
  const pending = await ctx.db.query.approvals.findMany({
    where: and(
      eq(approvals.workItemId, workItemId),
      eq(approvals.status, 'pending'),
    ),
  });
  for (const a of pending) {
    await withdrawApprovalInternal(ctx, a, reason);
  }
}
