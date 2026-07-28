import type { DerivedStatus } from '@nexus/contracts';
import type { ServiceContext } from '../context';
import { emit } from '../events/emit';

export async function emitWorkItemStatusChangedIfNeeded(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    workItemKey: string;
    projectId: string;
    from: DerivedStatus | null;
    to: DerivedStatus | null;
  },
): Promise<void> {
  const { workItemId, workItemKey, projectId, from, to } = input;
  if (!to || from === to) return;
  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId,
    type: 'work_item.status_changed',
    subjectType: 'work_item',
    subjectId: workItemId,
    actor: ctx.actor,
    payload: {
      key: workItemKey,
      from,
      to,
    },
  });
}
