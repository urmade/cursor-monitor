import { eq } from 'drizzle-orm';
import {
  AttentionWeightsSchema,
  DEFAULT_ATTENTION_WEIGHTS,
  type AttentionKind,
  type AttentionWeights,
} from '@nexus/contracts';
import { appMeta } from '@nexus/db';
import type { ServiceContext } from '../context';

const META_KEY = 'attention_weights';

export async function loadAttentionWeights(
  ctx: ServiceContext,
): Promise<AttentionWeights> {
  const row = await ctx.db.query.appMeta.findFirst({
    where: eq(appMeta.key, META_KEY),
  });
  if (!row?.value) return DEFAULT_ATTENTION_WEIGHTS;
  const parsed = AttentionWeightsSchema.safeParse(row.value);
  if (!parsed.success) return DEFAULT_ATTENTION_WEIGHTS;
  return {
    ...DEFAULT_ATTENTION_WEIGHTS,
    ...parsed.data,
    base: { ...DEFAULT_ATTENTION_WEIGHTS.base, ...parsed.data.base },
  };
}

export function kindSeverity(kind: AttentionKind): number {
  const order: AttentionKind[] = [
    'blocking_question',
    'budget_block',
    'run_failed',
    'run_completed_no_report',
    'pending_approval',
    'loop_escalation',
    'external_block',
  ];
  return order.length - order.indexOf(kind);
}
