import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Complexity } from '@nexus/contracts';
import { labels, workItemLabels, workItems } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import type { WorkItem } from './create';

export async function updateWorkItem(
  ctx: ServiceContext,
  id: string,
  patch: {
    title?: string;
    description?: string;
    complexity?: Complexity | null;
    externallyBlockedReason?: string | null;
  },
  expectedVersion: number,
): Promise<Result<WorkItem, CoreError>> {
  const existing = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, id), isNull(workItems.archivedAt)),
  });
  if (!existing) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'work_item.update', {
      type: 'work_item',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot update work item'));
  }

  if (existing.version !== expectedVersion) {
    return err(coreError('stale_version', 'Work item was modified by someone else', {
      expectedVersion,
      actualVersion: existing.version,
    }));
  }

  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(workItems)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.complexity !== undefined ? { complexity: patch.complexity } : {}),
        ...(patch.externallyBlockedReason !== undefined
          ? { externallyBlockedReason: patch.externallyBlockedReason }
          : {}),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(workItems.id, id), eq(workItems.version, expectedVersion)))
      .returning();

    if (!row) {
      return null;
    }

    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'work_item.updated',
      subjectType: 'work_item',
      subjectId: id,
      actor: ctx.actor,
      payload: { ...patch, version: row.version },
    });
    return row;
  });

  if (!updated) {
    return err(coreError('stale_version', 'Work item was modified by someone else'));
  }
  return ok(updated);
}

export async function setLabels(
  ctx: ServiceContext,
  id: string,
  change: { add: string[]; remove: string[] },
): Promise<Result<WorkItem, CoreError>> {
  const existing = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, id), isNull(workItems.archivedAt)),
  });
  if (!existing) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'work_item.update', {
      type: 'work_item',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot update work item'));
  }

  await ctx.db.transaction(async (tx) => {
    if (change.remove.length) {
      const toRemove = await tx.query.labels.findMany({
        where: and(
          eq(labels.projectId, existing.projectId),
          inArray(labels.key, change.remove),
        ),
      });
      for (const label of toRemove) {
        await tx
          .delete(workItemLabels)
          .where(
            and(
              eq(workItemLabels.workItemId, id),
              eq(workItemLabels.labelId, label.id),
            ),
          );
      }
    }

    if (change.add.length) {
      const toAdd = await tx.query.labels.findMany({
        where: and(
          eq(labels.projectId, existing.projectId),
          inArray(labels.key, change.add),
          isNull(labels.archivedAt),
        ),
      });
      for (const label of toAdd) {
        await tx
          .insert(workItemLabels)
          .values({
            workItemId: id,
            labelId: label.id,
            setByActor: ctx.actor,
          })
          .onConflictDoNothing();
      }
    }

    await tx
      .update(workItems)
      .set({
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, id));

    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'work_item.updated',
      subjectType: 'work_item',
      subjectId: id,
      actor: ctx.actor,
      payload: { labels: change },
    });
  });

  const refreshed = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, id),
  });
  return ok(refreshed!);
}

export async function archiveWorkItem(
  ctx: ServiceContext,
  id: string,
): Promise<Result<void, CoreError>> {
  const existing = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, id),
  });
  if (!existing || existing.archivedAt) {
    return err(coreError('not_found', 'Work item not found'));
  }

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'work_item.archive', {
      type: 'work_item',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot archive work item'));
  }

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(workItems)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(workItems.id, id));
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'work_item.archived',
      subjectType: 'work_item',
      subjectId: id,
      actor: ctx.actor,
      payload: { key: existing.key },
    });
  });

  return ok(undefined);
}
