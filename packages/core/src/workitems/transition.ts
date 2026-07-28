import { and, desc, eq, isNull } from 'drizzle-orm';
import type { GateTrigger } from '@nexus/contracts';
import {
  interventions,
  newId,
  stageInstances,
  stages,
  transitions,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { evaluateGates } from '../gates/evaluate';
import { withdrawPendingApprovals } from '../approvals';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import type { WorkItem } from './create';
import { computeTransitionDirection } from './transition-direction';

export type TransitionError = CoreError;

/** Public transition input — adapters must never pass internal gate-skip flags. */
export type TransitionInput = {
  toStageId: string;
  note?: string;
  reasonCode?: string;
  /** Owner/maintainer override — skips blocking gates; records intervention. */
  override?: { reason: string };
};

type AfterGatesOpts = {
  gateBatchId?: string;
  gateEvaluationId?: string;
};

export async function transitionWorkItem(
  ctx: ServiceContext,
  id: string,
  input: TransitionInput,
  expectedVersion: number,
): Promise<Result<WorkItem, TransitionError>> {
  return transitionWorkItemImpl(ctx, id, input, expectedVersion, {
    skipGateEvaluation: false,
  });
}

/**
 * Complete a transition after gates have already been evaluated (e.g. post-approval).
 * Not exported from the package public barrel — approval flow only.
 */
export async function transitionWorkItemAfterGates(
  ctx: ServiceContext,
  id: string,
  input: TransitionInput,
  expectedVersion: number,
  opts: AfterGatesOpts,
): Promise<Result<WorkItem, TransitionError>> {
  return transitionWorkItemImpl(ctx, id, input, expectedVersion, {
    skipGateEvaluation: true,
    gateBatchId: opts.gateBatchId,
    gateEvaluationId: opts.gateEvaluationId,
  });
}

async function transitionWorkItemImpl(
  ctx: ServiceContext,
  id: string,
  input: TransitionInput,
  expectedVersion: number,
  opts: {
    skipGateEvaluation: boolean;
    gateBatchId?: string;
    gateEvaluationId?: string;
  },
): Promise<Result<WorkItem, TransitionError>> {
  const existing = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, id), isNull(workItems.archivedAt)),
  });
  if (!existing) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'work_item.transition', {
      type: 'work_item',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot transition work item'));
  }

  if (existing.version !== expectedVersion) {
    return err(coreError('stale_version', 'Work item was modified by someone else'));
  }

  const toStage = await ctx.db.query.stages.findFirst({
    where: and(
      eq(stages.id, input.toStageId),
      eq(stages.projectId, existing.projectId),
      isNull(stages.archivedAt),
    ),
  });
  if (!toStage) {
    return err(coreError('invalid_transition', 'Target stage not found in project'));
  }

  const fromStage = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, existing.currentStageId),
  });

  const direction = computeTransitionDirection(
    fromStage?.position ?? null,
    toStage.position,
  );

  const trigger: GateTrigger = {
    kind: 'on_transition',
    fromStageId: existing.currentStageId,
    toStageId: toStage.id,
  };

  let gateEvaluationId: string | null = opts.gateEvaluationId ?? null;
  let gateBatchId: string | null = opts.gateBatchId ?? null;
  let overridden = false;

  if (!opts.skipGateEvaluation) {
    const batch = await evaluateGates(ctx, { workItemId: id, trigger });
    if (!batch.ok) return batch;

    const shouldBlock =
      batch.value.outcome === 'block' && !batch.value.observeOnly;

    if (shouldBlock) {
      if (input.override?.reason) {
        if (
          !can(ctx.actor, 'gate.override', {
            type: 'work_item',
            projectId: existing.projectId,
            role,
          })
        ) {
          return err(coreError('forbidden', 'Cannot override gates'));
        }
        if (!input.override.reason.trim()) {
          return err(coreError('validation', 'Override reason is required'));
        }
        overridden = true;
        await ctx.db.insert(interventions).values({
          id: newId(),
          workItemId: id,
          projectId: existing.projectId,
          kind: 'gate_override',
          actor: ctx.actor,
          target: { trigger, batchId: batch.value.batchId },
          detail: {
            reason: input.override.reason,
            blockedBy: batch.value.blockedBy.map((b) => ({
              gateId: b.gateId,
              gateName: b.gateName,
              reason: b.reason,
            })),
          },
        });
        await emit(ctx.db, {
          orgId: ctx.orgId,
          projectId: existing.projectId,
          type: 'intervention.recorded',
          subjectType: 'work_item',
          subjectId: id,
          actor: ctx.actor,
          payload: {
            kind: 'gate_override',
            reason: input.override.reason,
            batchId: batch.value.batchId,
          },
        });
        gateBatchId = batch.value.batchId;
        gateEvaluationId = batch.value.evaluationIds[0] ?? null;
      } else {
        return err(
          coreError('gate_blocked', 'Transition blocked by gate(s)', {
            batchId: batch.value.batchId,
            blockedBy: batch.value.blockedBy.map((b) => ({
              gateId: b.gateId,
              gateName: b.gateName,
              reason: b.reason,
              evidence: b.evidence,
              approvalId: b.approvalId,
            })),
            results: batch.value.results.map((r) => ({
              gateId: r.gateId,
              gateName: r.gateName,
              outcome: r.outcome,
              reason: r.reason,
            })),
          }),
        );
      }
    } else {
      gateBatchId = batch.value.batchId;
      gateEvaluationId = batch.value.evaluationIds[0] ?? null;
    }
  }

  const updated = await ctx.db.transaction(async (tx) => {
    const now = new Date();

    if (existing.currentStageInstanceId) {
      await tx
        .update(stageInstances)
        .set({ exitedAt: now })
        .where(eq(stageInstances.id, existing.currentStageInstanceId));
    }

    const last = await tx.query.stageInstances.findFirst({
      where: eq(stageInstances.workItemId, id),
      orderBy: [desc(stageInstances.seq)],
    });
    const nextSeq = (last?.seq ?? 0) + 1;
    const instanceId = newId();

    await tx.insert(stageInstances).values({
      id: instanceId,
      workItemId: id,
      stageId: toStage.id,
      seq: nextSeq,
      enteredAt: now,
    });

    await tx.insert(transitions).values({
      id: newId(),
      workItemId: id,
      fromStageId: existing.currentStageId,
      toStageId: toStage.id,
      direction,
      reasonCode: overridden
        ? 'gate_override'
        : (input.reasonCode ?? null),
      note: overridden
        ? input.override!.reason
        : (input.note ?? null),
      actor: {
        ...ctx.actor,
        ...(overridden ? { override: true } : {}),
      },
      gateEvaluationId,
      gateBatchId,
    });

    const [row] = await tx
      .update(workItems)
      .set({
        currentStageId: toStage.id,
        currentStageInstanceId: instanceId,
        ownerClass: toStage.defaultOwnerClass,
        version: existing.version + 1,
        updatedAt: now,
      })
      .where(and(eq(workItems.id, id), eq(workItems.version, expectedVersion)))
      .returning();

    if (!row) return null;

    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'work_item.stage_changed',
      subjectType: 'work_item',
      subjectId: id,
      actor: ctx.actor,
      payload: {
        fromStageId: existing.currentStageId,
        toStageId: toStage.id,
        direction,
        note: input.note ?? null,
        reasonCode: input.reasonCode ?? null,
        gateEvaluationId,
        gateBatchId,
        overridden,
      },
    });

    return row;
  });

  if (!updated) {
    return err(coreError('stale_version', 'Work item was modified by someone else'));
  }

  await withdrawPendingApprovals(
    ctx,
    id,
    `Withdrawn because item moved to stage ${toStage.key}`,
  );

  return ok(updated);
}

export async function listStageInstances(
  ctx: ServiceContext,
  workItemId: string,
) {
  return ctx.db.query.stageInstances.findMany({
    where: eq(stageInstances.workItemId, workItemId),
    orderBy: [desc(stageInstances.seq)],
  });
}

export async function listTransitions(ctx: ServiceContext, workItemId: string) {
  return ctx.db.query.transitions.findMany({
    where: eq(transitions.workItemId, workItemId),
    orderBy: [desc(transitions.createdAt)],
  });
}
