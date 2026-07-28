import { and, desc, eq, isNull } from 'drizzle-orm';
import type { GateTrigger, LoopTrigger } from '@nexus/contracts';
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
import {
  clearLoopEscalationInTx,
  closeOpenLoopEdgesInTx,
  countPriorVisits,
  isReturnEdge,
  nextVisitIndex,
  recordReturnEdgeInTx,
  recomputeReworkMsInTx,
  resolveReturnReason,
  setLoopEscalatedInTx,
} from '../loops';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import type { WorkItem } from './create';
import { computeTransitionDirection } from './transition-direction';
import { deriveWorkItemStatus } from '../status/facts';
import { emitWorkItemStatusChangedIfNeeded } from './status-changed';

export type TransitionError = CoreError;

type TransitionBase = {
  toStageId: string;
  note?: string;
  /** Owner/maintainer override — skips blocking gates; records intervention. */
  override?: { reason: string };
};

/**
 * Discriminated union: explicit returns require a reason code at the type level.
 * Callers that do not know direction yet may use AdvanceTransitionInput; the
 * service still rejects unexplained return edges at runtime.
 */
export type AdvanceTransitionInput = TransitionBase & {
  kind?: 'advance';
  reasonCode?: string;
};

export type ReturnTransitionInput = TransitionBase & {
  kind: 'return';
  reasonCode: string;
};

export type TransitionInput = AdvanceTransitionInput | ReturnTransitionInput;

/** Public transition input — adapters must never pass internal gate-skip flags. */
export type { TransitionInput as PublicTransitionInput };

type AfterGatesOpts = {
  gateBatchId?: string;
  gateEvaluationId?: string;
};

/** Thrown inside a drizzle transaction so the whole tx rolls back (B5). */
class StaleVersionConflict extends Error {
  constructor() {
    super('stale_version');
    this.name = 'StaleVersionConflict';
  }
}

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

/**
 * Internal-only: gate/system-initiated return with a trusted trigger.
 * Not on the public TransitionInput — adapters cannot forge gate_block reasons.
 */
export async function transitionWorkItemInternal(
  ctx: ServiceContext,
  id: string,
  input: TransitionInput & { loopTrigger: LoopTrigger },
  expectedVersion: number,
): Promise<Result<WorkItem, TransitionError>> {
  return transitionWorkItemImpl(ctx, id, input, expectedVersion, {
    skipGateEvaluation: false,
    loopTrigger: input.loopTrigger,
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
    /** Trusted internal trigger only — never from public adapters. */
    loopTrigger?: LoopTrigger;
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

  const statusBefore = await deriveWorkItemStatus(ctx, id);

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

  const loopsEnabled = await ctx.flags.isEnabled('p5.loops', existing.projectId);

  const priorVisits = await countPriorVisits(ctx.db, id, toStage.id);
  const willBeReturn =
    loopsEnabled &&
    isReturnEdge({ direction, priorVisitCount: priorVisits });

  const loopTrigger: LoopTrigger = opts.loopTrigger ?? {
    kind: 'human',
    by: ctx.actor.kind === 'human' ? ctx.actor.userId : ctx.actor.kind,
  };

  let resolvedReason: { reasonCode: string; note: string | null } | null = null;
  if (willBeReturn || input.kind === 'return') {
    const reasonResult = await resolveReturnReason(ctx, existing.projectId, {
      reasonCode: input.reasonCode,
      note: input.note,
      triggerKind: loopTrigger.kind,
    });
    if (!reasonResult.ok) return reasonResult;
    if (willBeReturn) {
      resolvedReason = reasonResult.value;
    }
  }

  const trigger: GateTrigger = {
    kind: 'on_transition',
    fromStageId: existing.currentStageId,
    toStageId: toStage.id,
  };

  let gateEvaluationId: string | null = opts.gateEvaluationId ?? null;
  let gateBatchId: string | null = opts.gateBatchId ?? null;
  let overridden = false;
  let escalateFromGate: {
    gateId: string;
    count: number;
    message: string;
  } | null = null;

  if (!opts.skipGateEvaluation) {
    const batch = await evaluateGates(ctx, {
      workItemId: id,
      trigger,
      prospectiveReturn: willBeReturn
        ? {
            fromStageId: existing.currentStageId,
            toStageId: toStage.id,
          }
        : undefined,
    });
    if (!batch.ok) return batch;

    for (const r of batch.value.results) {
      if (
        r.evaluator === 'loop_budget' &&
        r.evidence?.escalate === true &&
        typeof r.gateId === 'string'
      ) {
        escalateFromGate = {
          gateId: r.gateId,
          count: Number(r.evidence.count ?? 0),
          message: r.reason,
        };
      }
    }

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

  let updated: WorkItem;
  try {
    updated = await ctx.db.transaction(async (tx) => {
      const now = ctx.clock();
      const leavingInstanceId = existing.currentStageInstanceId;

      if (leavingInstanceId) {
        await tx
          .update(stageInstances)
          .set({ exitedAt: now })
          .where(eq(stageInstances.id, leavingInstanceId));

        // Absolute recompute — never increment (B2).
        await recomputeReworkMsInTx(tx, id, now);

        if (loopsEnabled) {
          await closeOpenLoopEdgesInTx(tx, {
            orgId: ctx.orgId,
            projectId: existing.projectId,
            workItemId: id,
            stageInstanceId: leavingInstanceId,
            actor: ctx.actor,
            closedAt: now,
          });
        }
      }

      if (loopsEnabled && direction === 'forward' && existing.loopEscalated) {
        await clearLoopEscalationInTx(tx, id);
      }

      const last = await tx.query.stageInstances.findFirst({
        where: eq(stageInstances.workItemId, id),
        orderBy: [desc(stageInstances.seq)],
      });
      const nextSeq = (last?.seq ?? 0) + 1;
      const instanceId = newId();
      const visitIndex = await nextVisitIndex(tx, id, toStage.id);

      await tx.insert(stageInstances).values({
        id: instanceId,
        workItemId: id,
        stageId: toStage.id,
        seq: nextSeq,
        visitIndex,
        isRework: visitIndex > 1,
        enteredAt: now,
      });

      const transitionId = newId();
      const reasonCode = overridden
        ? 'gate_override'
        : resolvedReason?.reasonCode ?? input.reasonCode ?? null;
      const note = overridden
        ? input.override!.reason
        : resolvedReason?.note ?? (input.note ?? null);

      await tx.insert(transitions).values({
        id: transitionId,
        workItemId: id,
        fromStageId: existing.currentStageId,
        toStageId: toStage.id,
        direction,
        reasonCode,
        note,
        actor: {
          ...ctx.actor,
          ...(overridden ? { override: true } : {}),
        },
        gateEvaluationId,
        gateBatchId,
        isReturnEdge: false,
      });

      if (willBeReturn && resolvedReason && existing.currentStageId) {
        // Override path: same reason on transition + edge (not free-text forge).
        const edgeReason = overridden
          ? 'gate_override'
          : resolvedReason.reasonCode;
        const edgeNote = overridden
          ? input.override!.reason
          : resolvedReason.note;
        await recordReturnEdgeInTx(tx, {
          orgId: ctx.orgId,
          projectId: existing.projectId,
          workItemId: id,
          transitionId,
          fromStageId: existing.currentStageId,
          toStageId: toStage.id,
          toStageInstanceId: instanceId,
          reasonCode: edgeReason,
          note: edgeNote,
          trigger: loopTrigger,
          actor: ctx.actor,
          occurredAt: now,
        });
      }

      // Escalation only after a successful transition (inside the same tx).
      if (escalateFromGate && !overridden) {
        await setLoopEscalatedInTx(tx, {
          orgId: ctx.orgId,
          workItemId: id,
          projectId: existing.projectId,
          gateId: escalateFromGate.gateId,
          count: escalateFromGate.count,
          message: escalateFromGate.message,
          actor: ctx.actor,
          now,
        });
      }

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

      // Must throw — drizzle commits on return null (B5).
      if (!row) throw new StaleVersionConflict();

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
          reasonCode: reasonCode,
          gateEvaluationId,
          gateBatchId,
          overridden,
          isReturnEdge: willBeReturn,
        },
      });

      return row;
    });
  } catch (e) {
    if (e instanceof StaleVersionConflict) {
      return err(
        coreError('stale_version', 'Work item was modified by someone else'),
      );
    }
    throw e;
  }

  await withdrawPendingApprovals(
    ctx,
    id,
    `Withdrawn because item moved to stage ${toStage.key}`,
  );

  if (toStage.isTerminal) {
    try {
      const { invalidateEstimateCacheForProject } = await import(
        '../estimates/estimate'
      );
      await invalidateEstimateCacheForProject(ctx, existing.projectId);
    } catch {
      // cache invalidation is best-effort
    }
  }

  const statusAfter = await deriveWorkItemStatus(ctx, id);
  await emitWorkItemStatusChangedIfNeeded(ctx, {
    workItemId: id,
    workItemKey: updated.key,
    projectId: existing.projectId,
    from: statusBefore,
    to: statusAfter,
  });

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
