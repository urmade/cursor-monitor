import { and, asc, eq, isNull, type InferSelectModel } from 'drizzle-orm';
import type { OwnerClass } from '@nexus/contracts';
import { newId, stages, workItems } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { err, ok, type Result } from '../result';
import { getProjectRole } from './members';

export type Stage = InferSelectModel<typeof stages>;

export async function listStages(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<Stage[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }
  const rows = await ctx.db.query.stages.findMany({
    where: and(eq(stages.projectId, projectId), isNull(stages.archivedAt)),
    orderBy: [asc(stages.position)],
  });
  return ok(rows);
}

export async function addStage(
  ctx: ServiceContext,
  input: {
    projectId: string;
    key: string;
    name: string;
    position: number;
    defaultOwnerClass: OwnerClass;
    isInitial?: boolean;
    isTerminal?: boolean;
  },
): Promise<Result<Stage[], CoreError>> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.manage_pipeline', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage pipeline'));
  }

  await ctx.db.transaction(async (tx) => {
    if (input.isInitial) {
      await tx
        .update(stages)
        .set({ isInitial: false, updatedAt: new Date() })
        .where(
          and(eq(stages.projectId, input.projectId), isNull(stages.archivedAt)),
        );
    }
    const id = newId();
    await tx.insert(stages).values({
      id,
      projectId: input.projectId,
      key: input.key,
      name: input.name,
      position: input.position,
      defaultOwnerClass: input.defaultOwnerClass,
      isInitial: input.isInitial ?? false,
      isTerminal: input.isTerminal ?? false,
    });
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'stage.created',
      subjectType: 'stage',
      subjectId: id,
      actor: ctx.actor,
      payload: {
        key: input.key,
        name: input.name,
        position: input.position,
      },
    });
  });

  return listStages(ctx, input.projectId);
}

export async function updateStage(
  ctx: ServiceContext,
  stageId: string,
  patch: { name?: string; position?: number; defaultOwnerClass?: OwnerClass },
): Promise<Result<Stage, CoreError>> {
  const existing = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, stageId),
  });
  if (!existing || existing.archivedAt) {
    return err(coreError('not_found', 'Stage not found'));
  }

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.manage_pipeline', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage pipeline'));
  }

  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(stages)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(stages.id, stageId))
      .returning();
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'stage.updated',
      subjectType: 'stage',
      subjectId: stageId,
      actor: ctx.actor,
      payload: patch,
    });
    return row!;
  });

  return ok(updated);
}

export async function reorderStages(
  ctx: ServiceContext,
  projectId: string,
  orderedIds: string[],
): Promise<Result<Stage[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.manage_pipeline', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage pipeline'));
  }

  await ctx.db.transaction(async (tx) => {
    let position = 100;
    for (const id of orderedIds) {
      await tx
        .update(stages)
        .set({ position, updatedAt: new Date() })
        .where(and(eq(stages.id, id), eq(stages.projectId, projectId)));
      position += 100;
    }
    await emit(tx, {
      orgId: ctx.orgId,
      projectId,
      type: 'stage.updated',
      subjectType: 'project',
      subjectId: projectId,
      actor: ctx.actor,
      payload: { reorder: orderedIds },
    });
  });

  return listStages(ctx, projectId);
}

export async function archiveStage(
  ctx: ServiceContext,
  stageId: string,
): Promise<Result<Stage[], CoreError>> {
  const existing = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, stageId),
  });
  if (!existing || existing.archivedAt) {
    return err(coreError('not_found', 'Stage not found'));
  }

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.manage_pipeline', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage pipeline'));
  }

  const holding = await ctx.db.query.workItems.findFirst({
    where: and(
      eq(workItems.currentStageId, stageId),
      isNull(workItems.archivedAt),
    ),
  });
  if (holding) {
    return err(
      coreError('conflict', 'Cannot archive a stage that holds work items'),
    );
  }

  if (existing.isInitial) {
    return err(coreError('invariant', 'Cannot archive the initial stage'));
  }

  if (existing.isTerminal) {
    const terminals = await ctx.db.query.stages.findMany({
      where: and(
        eq(stages.projectId, existing.projectId),
        isNull(stages.archivedAt),
        eq(stages.isTerminal, true),
      ),
    });
    if (terminals.length <= 1) {
      return err(coreError('invariant', 'Project must keep at least one terminal stage'));
    }
  }

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(stages)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(stages.id, stageId));
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'stage.archived',
      subjectType: 'stage',
      subjectId: stageId,
      actor: ctx.actor,
      payload: { key: existing.key },
    });
  });

  return listStages(ctx, existing.projectId);
}
