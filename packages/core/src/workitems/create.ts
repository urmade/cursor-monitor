import { and, asc, eq, isNull, sql, type InferSelectModel } from 'drizzle-orm';
import { CreateWorkItemInputSchema } from '@nexus/contracts';
import {
  labels,
  newId,
  projects,
  stageInstances,
  stages,
  transitions,
  workItemLabels,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export type WorkItem = InferSelectModel<typeof workItems>;

export async function createWorkItem(
  ctx: ServiceContext,
  raw: unknown,
): Promise<Result<WorkItem, CoreError>> {
  const input = CreateWorkItemInputSchema.parse(raw);
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'work_item.create', {
      type: 'work_item',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot create work items'));
  }

  const project = await ctx.db.query.projects.findFirst({
    where: and(eq(projects.id, input.projectId), isNull(projects.archivedAt)),
  });
  if (!project) return err(coreError('not_found', 'Project not found'));

  const initial = await ctx.db.query.stages.findFirst({
    where: and(
      eq(stages.projectId, input.projectId),
      eq(stages.isInitial, true),
      isNull(stages.archivedAt),
    ),
  });
  if (!initial) {
    return err(coreError('invariant', 'Project has no initial stage'));
  }

  const item = await ctx.db.transaction(async (tx) => {
    const numbered = await tx.execute(sql`
      update projects
      set next_item_number = next_item_number + 1, updated_at = now()
      where id = ${input.projectId}
      returning next_item_number
    `);
    const rows = numbered as unknown as Array<{ next_item_number: number }>;
    const allocated = rows[0]?.next_item_number;
    if (allocated === undefined) {
      throw new Error('Failed to allocate work item number');
    }
    const number = allocated - 1;
    const key = `${project.key}-${number}`;
    const workItemId = newId();
    const instanceId = newId();

    await tx.insert(workItems).values({
      id: workItemId,
      projectId: input.projectId,
      number,
      key,
      title: input.title,
      description: input.description ?? '',
      complexity: input.complexity ?? null,
      currentStageId: initial.id,
      ownerClass: initial.defaultOwnerClass,
      createdByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
    });

    await tx.insert(stageInstances).values({
      id: instanceId,
      workItemId,
      stageId: initial.id,
      seq: 1,
      visitIndex: 1,
    });

    await tx
      .update(workItems)
      .set({ currentStageInstanceId: instanceId })
      .where(eq(workItems.id, workItemId));

    await tx.insert(transitions).values({
      id: newId(),
      workItemId,
      fromStageId: null,
      toStageId: initial.id,
      direction: 'initial',
      actor: ctx.actor,
    });

    if (input.labelKeys?.length) {
      const projectLabels = await tx.query.labels.findMany({
        where: and(
          eq(labels.projectId, input.projectId),
          isNull(labels.archivedAt),
        ),
      });
      const byKey = new Map(projectLabels.map((l) => [l.key, l]));
      for (const lk of input.labelKeys) {
        const label = byKey.get(lk);
        if (!label) continue;
        await tx.insert(workItemLabels).values({
          workItemId,
          labelId: label.id,
          setByActor: ctx.actor,
        });
      }
    }

    await emit(tx, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: workItemId,
      actor: ctx.actor,
      payload: {
        key,
        title: input.title,
        complexity: input.complexity ?? null,
        stageId: initial.id,
      },
    });

    const [final] = await tx
      .select()
      .from(workItems)
      .where(eq(workItems.id, workItemId));
    return final!;
  });

  if (input.complexity) {
    try {
      const { applyComplexityBudget } = await import('../budgets/actions');
      await applyComplexityBudget(ctx, item.id, input.complexity);
    } catch {
      // optional
    }
  }

  return ok(item);
}

export async function listWorkItems(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<WorkItem[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }

  const rows = await ctx.db.query.workItems.findMany({
    where: and(eq(workItems.projectId, projectId), isNull(workItems.archivedAt)),
    orderBy: [asc(workItems.number)],
  });
  return ok(rows);
}

export async function getWorkItemByKey(
  ctx: ServiceContext,
  projectId: string,
  itemKey: string,
): Promise<Result<WorkItem, CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: and(
      eq(workItems.projectId, projectId),
      eq(workItems.key, itemKey),
      isNull(workItems.archivedAt),
    ),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  return ok(item);
}

export async function getWorkItem(
  ctx: ServiceContext,
  id: string,
): Promise<Result<WorkItem, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, id), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }
  return ok(item);
}
