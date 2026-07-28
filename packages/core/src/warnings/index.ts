import { and, desc, eq } from 'drizzle-orm';
import { interventions, newId, warnings, workItems } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export async function listWarnings(
  ctx: ServiceContext,
  workItemId: string,
  opts: { status?: 'open' | 'dismissed' | 'resolved' | 'all' } = {},
) {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
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

  const status = opts.status ?? 'open';
  const rows =
    status === 'all'
      ? await ctx.db.query.warnings.findMany({
          where: eq(warnings.workItemId, workItemId),
          orderBy: [desc(warnings.createdAt)],
        })
      : await ctx.db.query.warnings.findMany({
          where: and(
            eq(warnings.workItemId, workItemId),
            eq(warnings.status, status),
          ),
          orderBy: [desc(warnings.createdAt)],
        });
  return ok(rows);
}

export async function dismissWarning(
  ctx: ServiceContext,
  warningId: string,
  reason: string,
): Promise<Result<typeof warnings.$inferSelect, CoreError>> {
  if (!reason.trim()) {
    return err(coreError('validation', 'Dismissal reason is required'));
  }
  const row = await ctx.db.query.warnings.findFirst({
    where: eq(warnings.id, warningId),
  });
  if (!row) return err(coreError('not_found', 'Warning not found'));
  if (row.status !== 'open') {
    return err(coreError('conflict', 'Warning is not open'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, row.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.update', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot dismiss warning'));
  }

  const [updated] = await ctx.db
    .update(warnings)
    .set({
      status: 'dismissed',
      dismissedByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
      dismissedReason: reason,
      dismissedAt: new Date(),
    })
    .where(eq(warnings.id, warningId))
    .returning();

  await ctx.db.insert(interventions).values({
    id: newId(),
    workItemId: row.workItemId,
    projectId: item.projectId,
    kind: 'warning_dismissed',
    actor: ctx.actor,
    target: { warningId, code: row.code },
    detail: { reason },
  });

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'warning.dismissed',
    subjectType: 'warning',
    subjectId: warningId,
    actor: ctx.actor,
    payload: { reason, code: row.code },
  });

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'intervention.recorded',
    subjectType: 'work_item',
    subjectId: row.workItemId,
    actor: ctx.actor,
    payload: { kind: 'warning_dismissed', warningId },
  });

  return ok(updated!);
}
