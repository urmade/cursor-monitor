import type { ServiceContext } from '../context';
import { toDisplay } from '../cost/money';
import { computeBudgetState } from './state';
import { pauseItemForBudget } from './actions';
import { persistBudgetWarning } from './warnings';

export async function onRunCostCaptured(
  ctx: ServiceContext,
  input: { workItemId: string; projectId: string },
): Promise<void> {
  const state = await computeBudgetState(ctx, input.workItemId);
  if (!state) return;

  if (state.item.state === 'warn') {
    await persistBudgetWarning(ctx, {
      workItemId: input.workItemId,
      code: 'budget.item_soft',
      message: `Item spend crossed soft budget threshold (${state.item.ratio != null ? `${Math.round(state.item.ratio * 100)}%` : 'warn'}).`,
    });
  }

  if (state.project.state === 'warn') {
    await persistBudgetWarning(ctx, {
      workItemId: input.workItemId,
      code: 'budget.project_soft',
      message: `Project burn crossed soft cap (${state.project.ratio != null ? `${Math.round(state.project.ratio * 100)}%` : 'warn'}).`,
    });
  }

  if (state.item.state === 'blocked') {
    const budget = state.item.budgetMicro;
    await pauseItemForBudget(
      ctx,
      input.workItemId,
      budget
        ? `Hard item budget ${toDisplay(budget)} exceeded after run close-out.`
        : 'Hard item budget exceeded after run close-out.',
    );
    await persistBudgetWarning(ctx, {
      workItemId: input.workItemId,
      code: 'budget.item_hard',
      message: 'Item hard budget exceeded; item paused (budget).',
    });
  }
}
