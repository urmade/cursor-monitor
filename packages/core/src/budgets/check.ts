import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { err, ok, type Result } from '../result';
import { toDisplay } from '../cost/money';
import { computeBudgetState } from './state';
import { parseProjectBudgetSettings } from './settings';
import { projects, workItems } from '@nexus/db';
import { eq } from 'drizzle-orm';

export type BudgetDecision =
  | { allow: true; warn?: 'item_soft' | 'project_soft' }
  | {
      allow: false;
      reason: 'item_hard' | 'project_burn' | 'item_paused' | 'budget_unavailable';
      detail: string;
    };

export async function checkBudget(
  ctx: ServiceContext,
  input: { workItemId: string; reserve?: boolean },
): Promise<Result<BudgetDecision, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  if (!project) return err(coreError('not_found', 'Project not found'));

  const enforcementObserve =
    (project.settings as Record<string, unknown>)?.enforcement_mode === 'observe';

  let budgetsEnabled = true;
  try {
    budgetsEnabled = await ctx.flags.isEnabled('p4.budgets', item.projectId);
  } catch {
    budgetsEnabled = true;
  }
  if (!budgetsEnabled) {
    return ok({ allow: true });
  }

  let state;
  try {
    state = await computeBudgetState(ctx, input.workItemId);
  } catch (e) {
    return ok({
      allow: false,
      reason: 'budget_unavailable',
      detail: e instanceof Error ? e.message : 'Could not compute budget state',
    });
  }
  if (!state) {
    return ok({
      allow: false,
      reason: 'budget_unavailable',
      detail: 'Could not compute budget state',
    });
  }

  const settings = parseProjectBudgetSettings(project.settings as Record<string, unknown>);
  const reserve = input.reserve !== false ? settings.reserveMicroUsdPerRun : BigInt(0);

  if (item.pausedReason === 'budget') {
    if (enforcementObserve) {
      return ok({ allow: true, warn: 'item_soft' });
    }
    return ok({
      allow: false,
      reason: 'item_paused',
      detail: 'Work item is paused (budget). Raise the cap or resume after adjusting budget.',
    });
  }

  const itemBudget = state.item.budgetMicro;
  if (itemBudget != null && itemBudget > BigInt(0)) {
    const projected = state.item.spentMicro + state.item.reservedMicro + reserve;
    if (projected > itemBudget) {
      if (enforcementObserve) {
        return ok({ allow: true, warn: 'item_soft' });
      }
      return ok({
        allow: false,
        reason: 'item_hard',
        detail: `Item hard budget ${toDisplay(itemBudget)} would be exceeded (committed ${toDisplay(projected)} including reservations).`,
      });
    }
    const soft = state.item.softMicro ?? (itemBudget * BigInt(8)) / BigInt(10);
    if (projected > soft) {
      return ok({ allow: true, warn: 'item_soft' });
    }
  }

  if (settings.blockOnBurnCap && settings.burnCapMicroUsd != null) {
    const projected =
      state.project.spentMicro + state.project.reservedMicro + reserve;
    if (projected > settings.burnCapMicroUsd) {
      if (enforcementObserve) {
        return ok({ allow: true, warn: 'project_soft' });
      }
      return ok({
        allow: false,
        reason: 'project_burn',
        detail: `Project burn cap ${toDisplay(settings.burnCapMicroUsd)} would be exceeded (committed ${toDisplay(projected)} including reservations).`,
      });
    }
    const softCap =
      (settings.burnCapMicroUsd * BigInt(Math.round(settings.burnSoftRatio * 1000))) /
      BigInt(1000);
    if (projected > softCap) {
      return ok({ allow: true, warn: 'project_soft' });
    }
  }

  if (state.item.state === 'warn') {
    return ok({ allow: true, warn: 'item_soft' });
  }
  return ok({ allow: true });
}
