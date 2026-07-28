import type { ServiceContext } from '../context';

export async function budgetsFeatureEnabled(
  ctx: ServiceContext,
  projectId: string,
): Promise<boolean> {
  try {
    return await ctx.flags.isEnabled('p4.budgets', projectId);
  } catch {
    return true;
  }
}
