import { asc, eq } from 'drizzle-orm';
import { loopEdges, stageInstances, stages } from '@nexus/db';
import type { ServiceContext } from '../context';
import { can } from '../authz/can';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export type JourneyRibbonNode = {
  stageInstanceId: string;
  stageId: string;
  stageKey: string;
  stageName: string;
  visitIndex: number;
  seq: number;
  enteredAt: Date;
  exitedAt: Date | null;
  costMicroUsd: string;
  isRework: boolean;
};

export type JourneyRibbonArc = {
  loopEdgeId: string;
  fromStageId: string;
  toStageId: string;
  fromSeq: number;
  toSeq: number;
  reasonCode: string;
  note: string | null;
  costMicroUsd: string | null;
  costComplete: boolean;
  durationMs: string | null;
};

export type JourneyRibbonModel = {
  nodes: JourneyRibbonNode[];
  arcs: JourneyRibbonArc[];
  /** Collapsed repeated pairs for dense ribbons (five+ loops). */
  collapsedPairs: Array<{
    fromStageKey: string;
    toStageKey: string;
    count: number;
    reasonCodes: string[];
  }>;
  accessibleSummary: string;
};

/**
 * Historical path for the journey ribbon — rendered from stored
 * stage_instances + loop_edges, never from current pipeline order.
 */
export async function buildJourneyRibbonModel(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<JourneyRibbonModel, CoreError>> {
  const { workItems } = await import('@nexus/db');
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

  const instances = await ctx.db.query.stageInstances.findMany({
    where: eq(stageInstances.workItemId, workItemId),
    orderBy: [asc(stageInstances.seq)],
  });

  const stageIds = [...new Set(instances.map((i) => i.stageId))];
  const { inArray } = await import('drizzle-orm');
  const stageRows =
    stageIds.length === 0
      ? []
      : await ctx.db.query.stages.findMany({
          where: inArray(stages.id, stageIds),
        });
  const stageById = new Map(stageRows.map((s) => [s.id, s]));

  const edges = await ctx.db.query.loopEdges.findMany({
    where: eq(loopEdges.workItemId, workItemId),
    orderBy: [asc(loopEdges.occurredAt)],
  });

  const nodes: JourneyRibbonNode[] = instances.map((si) => {
    const stage = stageById.get(si.stageId);
    return {
      stageInstanceId: si.id,
      stageId: si.stageId,
      stageKey: stage?.key ?? 'archived',
      stageName: stage?.name ?? 'Archived stage',
      visitIndex: si.visitIndex,
      seq: si.seq,
      enteredAt: si.enteredAt,
      exitedAt: si.exitedAt,
      costMicroUsd: si.costMicroUsd.toString(),
      isRework: si.visitIndex > 1,
    };
  });

  // Map each loop edge to seqs: toSeq = first instance of to_stage after the edge time
  // with visit_index matching; fromSeq = last instance of from_stage before that.
  const arcs: JourneyRibbonArc[] = edges.map((e) => {
    const toNode =
      nodes.find(
        (n) =>
          n.stageId === e.toStageId &&
          n.enteredAt.getTime() >= e.occurredAt.getTime() - 2000,
      ) ?? nodes.filter((n) => n.stageId === e.toStageId).at(-1);
    const fromNode =
      nodes
        .filter(
          (n) =>
            n.stageId === e.fromStageId &&
            (!toNode || n.seq < toNode.seq),
        )
        .at(-1) ?? nodes.find((n) => n.stageId === e.fromStageId);

    return {
      loopEdgeId: e.id,
      fromStageId: e.fromStageId,
      toStageId: e.toStageId,
      fromSeq: fromNode?.seq ?? 0,
      toSeq: toNode?.seq ?? 0,
      reasonCode: e.reasonCode,
      note: e.note,
      costMicroUsd: e.costMicroUsd?.toString() ?? null,
      costComplete: e.costComplete,
      durationMs: e.durationMs?.toString() ?? null,
    };
  });

  const pairMap = new Map<
    string,
    {
      fromStageKey: string;
      toStageKey: string;
      count: number;
      reasonCodes: string[];
    }
  >();
  for (const e of edges) {
    const from = stageById.get(e.fromStageId);
    const to = stageById.get(e.toStageId);
    const key = `${from?.key ?? e.fromStageId}->${to?.key ?? e.toStageId}`;
    const cur = pairMap.get(key);
    if (cur) {
      cur.count += 1;
      if (!cur.reasonCodes.includes(e.reasonCode)) {
        cur.reasonCodes.push(e.reasonCode);
      }
    } else {
      pairMap.set(key, {
        fromStageKey: from?.key ?? 'archived',
        toStageKey: to?.key ?? 'archived',
        count: 1,
        reasonCodes: [e.reasonCode],
      });
    }
  }

  const parts: string[] = [];
  if (nodes.length === 0) {
    parts.push('No stage history.');
  } else {
    parts.push(
      `Path: ${nodes.map((n) => `${n.stageName}${n.visitIndex > 1 ? ` (visit ${n.visitIndex})` : ''}`).join(' → ')}.`,
    );
  }
  if (arcs.length) {
    parts.push(
      `${arcs.length} return${arcs.length === 1 ? '' : 's'}: ${arcs
        .map((a) => a.reasonCode)
        .join(', ')}.`,
    );
  }

  return ok({
    nodes,
    arcs,
    collapsedPairs: [...pairMap.values()],
    accessibleSummary: parts.join(' '),
  });
}
