import { and, asc, eq, isNull, type InferSelectModel } from 'drizzle-orm';
import { labels, newId } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { err, ok, type Result } from '../result';
import { getProjectRole } from './members';

export type Label = InferSelectModel<typeof labels>;

export async function listLabels(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<Label[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }
  const rows = await ctx.db.query.labels.findMany({
    where: and(eq(labels.projectId, projectId), isNull(labels.archivedAt)),
    orderBy: [asc(labels.key)],
  });
  return ok(rows);
}

export async function upsertLabel(
  ctx: ServiceContext,
  input: {
    projectId: string;
    key: string;
    name: string;
    color?: string;
    category?: string | null;
    agentSettable?: boolean;
  },
): Promise<Result<Label, CoreError>> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.manage_labels', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage labels'));
  }

  const existing = await ctx.db.query.labels.findFirst({
    where: and(
      eq(labels.projectId, input.projectId),
      eq(labels.key, input.key),
    ),
  });

  const row = await ctx.db.transaction(async (tx) => {
    if (existing) {
      const [updated] = await tx
        .update(labels)
        .set({
          name: input.name,
          color: input.color ?? existing.color,
          category: input.category === undefined ? existing.category : input.category,
          agentSettable: input.agentSettable ?? existing.agentSettable,
          archivedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(labels.id, existing.id))
        .returning();
      await emit(tx, {
        orgId: ctx.orgId,
        projectId: input.projectId,
        type: 'label.updated',
        subjectType: 'label',
        subjectId: existing.id,
        actor: ctx.actor,
        payload: { key: input.key, name: input.name },
      });
      return updated!;
    }

    const id = newId();
    const [created] = await tx
      .insert(labels)
      .values({
        id,
        projectId: input.projectId,
        key: input.key,
        name: input.name,
        color: input.color ?? 'gray',
        category: input.category ?? null,
        agentSettable: input.agentSettable ?? true,
      })
      .returning();
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'label.created',
      subjectType: 'label',
      subjectId: id,
      actor: ctx.actor,
      payload: { key: input.key, name: input.name },
    });
    return created!;
  });

  return ok(row);
}

export async function archiveLabel(
  ctx: ServiceContext,
  labelId: string,
): Promise<Result<void, CoreError>> {
  const existing = await ctx.db.query.labels.findFirst({
    where: eq(labels.id, labelId),
  });
  if (!existing || existing.archivedAt) {
    return err(coreError('not_found', 'Label not found'));
  }

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.manage_labels', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage labels'));
  }

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(labels)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(labels.id, labelId));
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: existing.projectId,
      type: 'label.archived',
      subjectType: 'label',
      subjectId: labelId,
      actor: ctx.actor,
      payload: { key: existing.key },
    });
  });

  return ok(undefined);
}
