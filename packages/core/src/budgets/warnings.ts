import { and, eq } from 'drizzle-orm';
import { newId, warnings } from '@nexus/db';
import type { ServiceContext } from '../context';
import { emit } from '../events/emit';
import { workItems } from '@nexus/db';

export async function persistBudgetWarning(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    code: string;
    message: string;
    stageInstanceId?: string | null;
    gateId?: string | null;
  },
): Promise<void> {
  const existing = await ctx.db.query.warnings.findFirst({
    where: and(
      eq(warnings.workItemId, input.workItemId),
      eq(warnings.code, input.code),
      eq(warnings.status, 'open'),
    ),
  });
  if (existing) return;

  const id = newId();
  await ctx.db.insert(warnings).values({
    id,
    workItemId: input.workItemId,
    gateId: input.gateId ?? null,
    gateEvaluationId: null,
    originStageInstanceId: input.stageInstanceId ?? null,
    code: input.code,
    message: input.message,
    status: 'open',
  });

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item?.projectId ?? null,
    type: 'warning.created',
    subjectType: 'warning',
    subjectId: id,
    actor: { kind: 'system', reason: 'budget' },
    payload: { code: input.code, workItemId: input.workItemId },
  });

  if (input.code.includes('soft') && item?.projectId) {
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'budget.threshold_crossed',
      subjectType: 'work_item',
      subjectId: input.workItemId,
      actor: { kind: 'system', reason: 'budget' },
      payload: {
        scope: input.code.includes('project') ? 'project' : 'item',
        threshold: input.code,
      },
    });
  }
}
