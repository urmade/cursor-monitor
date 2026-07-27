import { and, desc, eq, isNull } from 'drizzle-orm';
import {
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
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import type { WorkItem } from './create';
import { computeTransitionDirection } from './transition-direction';

export type TransitionError = CoreError;

export async function transitionWorkItem(
  ctx: ServiceContext,
  id: string,
  input: { toStageId: string; note?: string; reasonCode?: string },
  expectedVersion: number,
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
      reasonCode: input.reasonCode ?? null,
      note: input.note ?? null,
      actor: ctx.actor,
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
      },
    });

    return row;
  });

  if (!updated) {
    return err(coreError('stale_version', 'Work item was modified by someone else'));
  }
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
