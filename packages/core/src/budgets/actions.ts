import { desc, eq } from 'drizzle-orm';
import { budgetEvents, interventions, newId, projects, workItems } from '@nexus/db';
import type { Complexity } from '@nexus/contracts';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import type { MicroUsd } from '../cost/money';
import {
  hardBudgetForComplexity,
  parseProjectBudgetSettings,
} from './settings';
import { computeBudgetState, recordBudgetEvent } from './state';

export async function applyComplexityBudget(
  ctx: ServiceContext,
  workItemId: string,
  complexity: Complexity | null,
): Promise<void> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item || item.budgetOverridden) return;

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  if (!project) return;

  const settings = parseProjectBudgetSettings(project.settings as Record<string, unknown>);
  const next = complexity ? hardBudgetForComplexity(settings, complexity) : null;
  if (next === item.budgetMicroUsd) return;

  const before = {
    budgetMicroUsd: item.budgetMicroUsd?.toString() ?? null,
    complexity: item.complexity,
  };
  await ctx.db
    .update(workItems)
    .set({
      budgetMicroUsd: next,
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, workItemId));

  await recordBudgetEvent(ctx.db, {
    projectId: item.projectId,
    workItemId,
    kind: 'budget_applied',
    scope: 'item',
    before,
    after: {
      budgetMicroUsd: next?.toString() ?? null,
      complexity,
    },
    actor: ctx.actor,
    reason: 'Complexity default budget applied',
  });
}

export async function setItemBudget(
  ctx: ServiceContext,
  workItemId: string,
  input: { micro: MicroUsd; reason: string },
): Promise<Result<typeof workItems.$inferSelect, CoreError>> {
  if (!input.reason.trim()) {
    return err(coreError('validation', 'Reason is required'));
  }
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot override item budget'));
  }

  const before = {
    budgetMicroUsd: item.budgetMicroUsd?.toString() ?? null,
    budgetOverridden: item.budgetOverridden,
  };

  const [row] = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(workItems)
      .set({
        budgetMicroUsd: input.micro,
        budgetOverridden: true,
        pausedReason:
          item.pausedReason === 'budget' ? null : item.pausedReason,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, workItemId))
      .returning();

    await recordBudgetEvent(tx, {
      projectId: item.projectId,
      workItemId,
      kind: 'budget_overridden',
      scope: 'item',
      before,
      after: {
        budgetMicroUsd: input.micro.toString(),
        budgetOverridden: true,
      },
      actor: ctx.actor,
      reason: input.reason,
    });

    await tx.insert(interventions).values({
      id: newId(),
      projectId: item.projectId,
      workItemId,
      kind: 'budget_raise',
      actor: ctx.actor,
      target: { workItemId },
      detail: { reason: input.reason, budgetMicroUsd: input.micro.toString() },
    });

    return [updated];
  });

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'budget.item_overridden',
    subjectType: 'work_item',
    subjectId: workItemId,
    actor: ctx.actor,
    payload: { micro: input.micro.toString(), reason: input.reason },
  });

  return ok(row!);
}

export async function raiseProjectCap(
  ctx: ServiceContext,
  projectId: string,
  input: { micro: MicroUsd; reason: string },
): Promise<Result<typeof projects.$inferSelect, CoreError>> {
  if (!input.reason.trim()) {
    return err(coreError('validation', 'Reason is required'));
  }
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot raise project cap'));
  }

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) return err(coreError('not_found', 'Project not found'));

  const settings = parseProjectBudgetSettings(project.settings as Record<string, unknown>);
  const beforeCap = settings.burnCapMicroUsd?.toString() ?? null;

  const nextSettings = {
    ...(project.settings as Record<string, unknown>),
    budget: {
      ...((project.settings as Record<string, unknown>).budget as object),
      burnCapMicroUsd: input.micro.toString(),
    },
  };

  const [row] = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(projects)
      .set({ settings: nextSettings, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();

    await recordBudgetEvent(tx, {
      projectId,
      kind: 'cap_raised',
      scope: 'project',
      before: { burnCapMicroUsd: beforeCap },
      after: { burnCapMicroUsd: input.micro.toString() },
      actor: ctx.actor,
      reason: input.reason,
    });

    await tx.insert(interventions).values({
      id: newId(),
      projectId,
      workItemId: null,
      kind: 'budget_raise',
      actor: ctx.actor,
      target: { projectId },
      detail: { reason: input.reason, burnCapMicroUsd: input.micro.toString() },
    });

    return [updated];
  });

  return ok(row!);
}

export async function pauseItemForBudget(
  ctx: ServiceContext,
  workItemId: string,
  reason: string,
): Promise<void> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return;

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(workItems)
      .set({ pausedReason: 'budget', updatedAt: new Date() })
      .where(eq(workItems.id, workItemId));

    await recordBudgetEvent(tx, {
      projectId: item.projectId,
      workItemId,
      kind: 'paused',
      scope: 'item',
      before: { pausedReason: item.pausedReason },
      after: { pausedReason: 'budget' },
      actor: { kind: 'system', reason: 'budget_threshold' },
      reason,
    });

    await tx.insert(interventions).values({
      id: newId(),
      projectId: item.projectId,
      workItemId,
      kind: 'budget_raise',
      actor: { kind: 'system', reason: 'budget_pause' },
      target: { workItemId },
      detail: { reason, paused: true },
    });
  });
}

export async function resumeItemBudget(
  ctx: ServiceContext,
  workItemId: string,
  reason: string,
): Promise<Result<typeof workItems.$inferSelect, CoreError>> {
  if (!reason.trim()) {
    return err(coreError('validation', 'Reason is required'));
  }
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
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
    return err(coreError('forbidden', 'Cannot resume item'));
  }

  const state = await computeBudgetState(ctx, workItemId);
  if (state?.item.state === 'blocked') {
    return err(
      coreError('validation', 'Item is still over hard budget; raise cap or budget first'),
    );
  }

  const [row] = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(workItems)
      .set({ pausedReason: null, updatedAt: new Date() })
      .where(eq(workItems.id, workItemId))
      .returning();

    await recordBudgetEvent(tx, {
      projectId: item.projectId,
      workItemId,
      kind: 'resumed',
      scope: 'item',
      before: { pausedReason: item.pausedReason },
      after: { pausedReason: null },
      actor: ctx.actor,
      reason,
    });

    await tx.insert(interventions).values({
      id: newId(),
      projectId: item.projectId,
      workItemId,
      kind: 'budget_raise',
      actor: ctx.actor,
      target: { workItemId },
      detail: { reason, resumed: true },
    });

    return [updated];
  });

  return ok(row!);
}

export async function listBudgetEvents(
  ctx: ServiceContext,
  projectId: string,
  limit = 100,
) {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot list budget events'));
  }

  const rows = await ctx.db.query.budgetEvents.findMany({
    where: eq(budgetEvents.projectId, projectId),
    orderBy: [desc(budgetEvents.createdAt)],
    limit,
  });
  return ok(rows);
}
