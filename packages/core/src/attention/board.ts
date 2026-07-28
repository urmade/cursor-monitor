import { and, eq, isNull } from 'drizzle-orm';
import { attentionItems, workItems } from '@nexus/db';
import type { ServiceContext } from '../context';
import { countInbox, getInFlightSummary } from './list';
import { deriveStatus } from '../status/derive';
import { loadStatusFactsForWorkItems } from '../status/facts';

export type AttentionLane = 'needs_me' | 'ai_working' | 'blocked_external' | 'done';

export function classifyAttentionLaneFromFacts(input: {
  workItemId: string;
  hasOpenAttention: boolean;
  status: ReturnType<typeof deriveStatus> | null;
  pausedReason: string | null;
}): AttentionLane {
  if (input.hasOpenAttention) return 'needs_me';
  if (input.status === 'archived' || input.status === 'abandoned') return 'done';
  if (input.pausedReason === 'external' || input.status === 'blocked_external') {
    return 'blocked_external';
  }
  if (input.status === 'paused_budget' || input.status === 'blocked_by_gate') {
    return 'blocked_external';
  }
  return 'ai_working';
}

export async function boardAttentionSummary(
  ctx: ServiceContext,
  projectId: string,
): Promise<{
  lanes: Record<AttentionLane, number>;
  inboxOpen: number;
  inFlight: {
    itemsInFlight: number;
    oldestRunMinutes: number | null;
    activeRunCount: number;
    lastHumanAttentionAt: Date | null;
  };
}> {
  const items = await ctx.db.query.workItems.findMany({
    where: and(eq(workItems.projectId, projectId), isNull(workItems.archivedAt)),
  });

  const openAttention = await ctx.db.query.attentionItems.findMany({
    where: and(eq(attentionItems.projectId, projectId), eq(attentionItems.status, 'open')),
  });
  const needsMeIds = new Set(openAttention.map((r) => r.workItemId));

  const factsByItem = await loadStatusFactsForWorkItems(
    ctx,
    items.map((i) => ({
      id: i.id,
      pausedReason: i.pausedReason,
      loopEscalated: i.loopEscalated,
      currentStageInstanceId: i.currentStageInstanceId,
    })),
  );

  const lanes: Record<AttentionLane, number> = {
    needs_me: 0,
    ai_working: 0,
    blocked_external: 0,
    done: 0,
  };

  for (const item of items) {
    const facts = factsByItem.get(item.id) ?? {};
    const status = deriveStatus(
      {
        archivedAt: item.archivedAt,
        externallyBlockedReason: item.externallyBlockedReason,
      },
      facts,
    );
    const lane = classifyAttentionLaneFromFacts({
      workItemId: item.id,
      hasOpenAttention: needsMeIds.has(item.id),
      status,
      pausedReason: item.pausedReason,
    });
    lanes[lane] += 1;
  }

  const counts = await countInbox(ctx, { projectIds: [projectId] });
  const inboxOpen = counts.ok
    ? Object.values(counts.value).reduce((a, b) => a + b, 0)
    : 0;
  const flight = await getInFlightSummary(ctx, [projectId]);

  return {
    lanes,
    inboxOpen,
    inFlight: flight.ok
      ? flight.value
      : {
          itemsInFlight: 0,
          oldestRunMinutes: null,
          activeRunCount: 0,
          lastHumanAttentionAt: null,
        },
  };
}
