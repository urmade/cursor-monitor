import { and, eq } from 'drizzle-orm';
import type { ProjectRole } from '@nexus/contracts';
import { projectMembers } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { err, ok, type Result } from '../result';

async function memberRole(
  ctx: ServiceContext,
  projectId: string,
): Promise<ProjectRole | null> {
  if (ctx.actor.kind !== 'human') return null;
  const row = await ctx.db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, ctx.actor.userId),
    ),
  });
  return row?.role ?? null;
}

export async function addMember(
  ctx: ServiceContext,
  input: { projectId: string; userId: string; role: ProjectRole },
): Promise<Result<void, CoreError>> {
  const role = await memberRole(ctx, input.projectId);
  if (!can(ctx.actor, 'project.manage_members', { type: 'project', projectId: input.projectId, role })) {
    return err(coreError('forbidden', 'Cannot manage members'));
  }

  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(projectMembers)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: input.role, updatedAt: new Date() },
      });
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'member.added',
      subjectType: 'project',
      subjectId: input.projectId,
      actor: ctx.actor,
      payload: { userId: input.userId, role: input.role },
    });
  });

  return ok(undefined);
}

export async function changeMemberRole(
  ctx: ServiceContext,
  input: { projectId: string; userId: string; role: ProjectRole },
): Promise<Result<void, CoreError>> {
  const role = await memberRole(ctx, input.projectId);
  if (!can(ctx.actor, 'project.manage_members', { type: 'project', projectId: input.projectId, role })) {
    return err(coreError('forbidden', 'Cannot manage members'));
  }

  const existing = await ctx.db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, input.projectId),
      eq(projectMembers.userId, input.userId),
    ),
  });
  if (!existing) return err(coreError('not_found', 'Member not found'));

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(projectMembers)
      .set({ role: input.role, updatedAt: new Date() })
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, input.userId),
        ),
      );
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'member.role_changed',
      subjectType: 'project',
      subjectId: input.projectId,
      actor: ctx.actor,
      payload: {
        userId: input.userId,
        from: existing.role,
        to: input.role,
      },
    });
  });

  return ok(undefined);
}

export async function removeMember(
  ctx: ServiceContext,
  input: { projectId: string; userId: string },
): Promise<Result<void, CoreError>> {
  const role = await memberRole(ctx, input.projectId);
  if (!can(ctx.actor, 'project.manage_members', { type: 'project', projectId: input.projectId, role })) {
    return err(coreError('forbidden', 'Cannot manage members'));
  }

  await ctx.db.transaction(async (tx) => {
    await tx
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, input.userId),
        ),
      );
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'member.removed',
      subjectType: 'project',
      subjectId: input.projectId,
      actor: ctx.actor,
      payload: { userId: input.userId },
    });
  });

  return ok(undefined);
}

export async function getProjectRole(
  ctx: ServiceContext,
  projectId: string,
): Promise<ProjectRole | null> {
  return memberRole(ctx, projectId);
}
