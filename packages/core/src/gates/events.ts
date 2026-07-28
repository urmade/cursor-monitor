import type { GateTrigger } from '@nexus/contracts';
import type { ServiceContext } from '../context';
import { evaluateGates } from './evaluate';

/** Fire gates whose trigger matches a finished run. */
export async function evaluateOnRunFinished(
  ctx: ServiceContext,
  input: { workItemId: string; stageId?: string },
) {
  const trigger: GateTrigger = {
    kind: 'on_run_finished',
    ...(input.stageId ? { stageId: input.stageId } : {}),
  };
  return evaluateGates(ctx, { workItemId: input.workItemId, trigger });
}

/** Fire gates whose trigger matches a newly added label. */
export async function evaluateOnLabelAdded(
  ctx: ServiceContext,
  input: { workItemId: string; labelKey: string },
) {
  const trigger: GateTrigger = {
    kind: 'on_label_added',
    labelKey: input.labelKey,
  };
  return evaluateGates(ctx, { workItemId: input.workItemId, trigger });
}
