import { and, asc, eq, sql, type InferSelectModel } from 'drizzle-orm';
import {
  LoopTriggerSchema,
  type Actor,
  type LoopTrigger,
} from '@nexus/contracts';
import {
  loopEdges,
  newId,
  stageInstances,
  stages,
  transitions,
  workItems,
  type Db,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit, type Tx } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

function parseTrigger(raw: unknown): LoopTrigger {
  const parsed = LoopTriggerSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : { kind: 'system', by: 'unparseable_trigger' };
}

export type LoopEdge = InferSelectModel<typeof loopEdges>;

export type LoopSummary = {
  count: number;
  escalated: boolean;
  reworkCostMicroUsd: bigint;
  reworkMs: bigint;
  spendMicroUsd: bigint;
  edges: Array<{
    id: string;
    fromStageId: string;
    toStageId: string;
    fromStageName: string;
    toStageName: string;
    fromStageKey: string;
    toStageKey: string;
    reasonCode: string;
    note: string | null;
    trigger: LoopTrigger;
    occurredAt: Date;
    closedAt: Date | null;
    costMicroUsd: bigint | null;
    durationMs: bigint | null;
    costComplete: boolean;
  }>;
  byStagePair: Array<{
    fromStageId: string;
    toStageId: string;
    fromStageName: string;
    toStageName: string;
    count: number;
  }>;
};

/**
 * A transition is a return edge when direction is backward AND the target
 * stage already has a prior stage_instance for this work item.
 */
export function isReturnEdge(input: {
  direction: string;
  priorVisitCount: number;
}): boolean {
  return input.direction === 'backward' && input.priorVisitCount > 0;
}

export async function countPriorVisits(
  db: Db | Tx,
  workItemId: string,
  stageId: string,
): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(stageInstances)
    .where(
      and(
        eq(stageInstances.workItemId, workItemId),
        eq(stageInstances.stageId, stageId),
      ),
    );
  return Number(rows[0]?.c ?? 0);
}

export async function nextVisitIndex(
  db: Db | Tx,
  workItemId: string,
  stageId: string,
): Promise<number> {
  return (await countPriorVisits(db, workItemId, stageId)) + 1;
}

/**
 * Record a return edge inside an open transaction. Caller has already
 * validated the reason and inserted the transition row.
 */
export async function recordReturnEdgeInTx(
  tx: Tx,
  input: {
    orgId: string;
    projectId: string;
    workItemId: string;
    transitionId: string;
    fromStageId: string;
    toStageId: string;
    /** Stage instance created by this return — cost is finalised from this row. */
    toStageInstanceId: string;
    reasonCode: string;
    note: string | null;
    trigger: LoopTrigger;
    actor: Actor;
    occurredAt: Date;
  },
): Promise<LoopEdge> {
  const edgeId = newId();
  const [edge] = await tx
    .insert(loopEdges)
    .values({
      id: edgeId,
      workItemId: input.workItemId,
      transitionId: input.transitionId,
      fromStageId: input.fromStageId,
      toStageId: input.toStageId,
      toStageInstanceId: input.toStageInstanceId,
      reasonCode: input.reasonCode,
      note: input.note,
      trigger: input.trigger,
      occurredAt: input.occurredAt,
      createdAt: input.occurredAt,
      costComplete: false,
    })
    .returning();

  await tx
    .update(transitions)
    .set({ isReturnEdge: true, loopEdgeId: edgeId })
    .where(eq(transitions.id, input.transitionId));

  await tx
    .update(workItems)
    .set({
      loopCount: sql`${workItems.loopCount} + 1`,
      updatedAt: input.occurredAt,
    })
    .where(eq(workItems.id, input.workItemId));

  await emit(tx, {
    orgId: input.orgId,
    projectId: input.projectId,
    type: 'loop.detected',
    subjectType: 'work_item',
    subjectId: input.workItemId,
    actor: input.actor,
    payload: {
      loopEdgeId: edgeId,
      transitionId: input.transitionId,
      fromStageId: input.fromStageId,
      toStageId: input.toStageId,
      reasonCode: input.reasonCode,
      trigger: input.trigger,
    },
  });

  return edge!;
}

/**
 * Finalise per-edge cost when leaving the stage instance that opened the edge.
 * Runs on any departure (forward or return) so cost is never attributed to a later visit.
 */
export async function closeOpenLoopEdgesInTx(
  tx: Tx,
  input: {
    orgId: string;
    projectId: string;
    workItemId: string;
    stageInstanceId: string;
    actor: Actor;
    closedAt: Date;
  },
): Promise<LoopEdge[]> {
  const open = await tx.query.loopEdges.findMany({
    where: and(
      eq(loopEdges.workItemId, input.workItemId),
      eq(loopEdges.toStageInstanceId, input.stageInstanceId),
      eq(loopEdges.costComplete, false),
    ),
    orderBy: [asc(loopEdges.occurredAt)],
  });
  if (open.length === 0) return [];

  const instance = await tx.query.stageInstances.findFirst({
    where: eq(stageInstances.id, input.stageInstanceId),
  });
  if (!instance) return [];

  const durationMs = BigInt(
    Math.max(0, input.closedAt.getTime() - instance.enteredAt.getTime()),
  );
  const cost = instance.costMicroUsd ?? BigInt(0);
  const closed: LoopEdge[] = [];

  for (const target of open) {
    const [updated] = await tx
      .update(loopEdges)
      .set({
        closedAt: input.closedAt,
        costMicroUsd: cost,
        durationMs,
        costComplete: true,
      })
      .where(eq(loopEdges.id, target.id))
      .returning();

    if (updated) {
      closed.push(updated);
      await emit(tx, {
        orgId: input.orgId,
        projectId: input.projectId,
        type: 'loop.edge_closed',
        subjectType: 'loop_edge',
        subjectId: target.id,
        actor: input.actor,
        payload: {
          workItemId: input.workItemId,
          costMicroUsd: cost.toString(),
          durationMs: durationMs.toString(),
          stageInstanceId: input.stageInstanceId,
        },
      });
    }
  }

  return closed;
}

/**
 * Absolute recompute of closed-visit rework duration — never increments.
 * Only visits with visit_index > 1 AND exited_at IS NOT NULL contribute.
 */
export async function recomputeReworkMsInTx(
  tx: Tx,
  workItemId: string,
  now: Date,
): Promise<void> {
  const closed = await tx
    .select({
      enteredAt: stageInstances.enteredAt,
      exitedAt: stageInstances.exitedAt,
    })
    .from(stageInstances)
    .where(
      and(
        eq(stageInstances.workItemId, workItemId),
        sql`${stageInstances.visitIndex} > 1`,
        sql`${stageInstances.exitedAt} is not null`,
      ),
    );

  let totalMs = 0;
  for (const row of closed) {
    if (!row.exitedAt) continue;
    totalMs += Math.max(0, row.exitedAt.getTime() - row.enteredAt.getTime());
  }

  await tx
    .update(workItems)
    .set({
      reworkMs: BigInt(totalMs),
      updatedAt: now,
    })
    .where(eq(workItems.id, workItemId));
}

export async function clearLoopEscalationInTx(
  tx: Tx,
  workItemId: string,
): Promise<void> {
  await tx
    .update(workItems)
    .set({ loopEscalated: false, updatedAt: new Date() })
    .where(
      and(eq(workItems.id, workItemId), eq(workItems.loopEscalated, true)),
    );
}

/**
 * Persist escalation only on false→true (no event spam on every later evaluation).
 * Must run inside the successful transition transaction.
 */
export async function setLoopEscalatedInTx(
  db: Db | Tx,
  input: {
    orgId: string;
    workItemId: string;
    projectId: string;
    gateId: string;
    count: number;
    message: string;
    actor: Actor;
    now: Date;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ loopEscalated: workItems.loopEscalated })
    .from(workItems)
    .where(eq(workItems.id, input.workItemId))
    .limit(1);
  if (!row || row.loopEscalated) return false;

  await db
    .update(workItems)
    .set({ loopEscalated: true, updatedAt: input.now })
    .where(
      and(
        eq(workItems.id, input.workItemId),
        eq(workItems.loopEscalated, false),
      ),
    );

  await emit(db, {
    orgId: input.orgId,
    projectId: input.projectId,
    type: 'loop.escalated',
    subjectType: 'work_item',
    subjectId: input.workItemId,
    actor: input.actor,
    payload: {
      gateId: input.gateId,
      count: input.count,
      message: input.message,
    },
  });
  return true;
}

export async function getLoopSummary(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<LoopSummary, CoreError>> {
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

  const edges = await ctx.db.query.loopEdges.findMany({
    where: eq(loopEdges.workItemId, workItemId),
    orderBy: [asc(loopEdges.occurredAt)],
  });

  const stageIds = [
    ...new Set(edges.flatMap((e) => [e.fromStageId, e.toStageId])),
  ];
  const { inArray } = await import('drizzle-orm');
  const stagesList =
    stageIds.length === 0
      ? []
      : await ctx.db.query.stages.findMany({
          where: inArray(stages.id, stageIds),
        });
  const stageById = new Map(stagesList.map((s) => [s.id, s]));

  const byPairMap = new Map<
    string,
    {
      fromStageId: string;
      toStageId: string;
      fromStageName: string;
      toStageName: string;
      count: number;
    }
  >();

  const mapped = edges.map((e) => {
    const from = stageById.get(e.fromStageId);
    const to = stageById.get(e.toStageId);
    const key = `${e.fromStageId}->${e.toStageId}`;
    const existing = byPairMap.get(key);
    if (existing) existing.count += 1;
    else {
      byPairMap.set(key, {
        fromStageId: e.fromStageId,
        toStageId: e.toStageId,
        fromStageName: from?.name ?? e.fromStageId.slice(0, 8),
        toStageName: to?.name ?? e.toStageId.slice(0, 8),
        count: 1,
      });
    }

    // Running total for open edges: use current stage instance cost when incomplete.
    const costMicroUsd = e.costMicroUsd;
    const durationMs = e.durationMs;

    return {
      id: e.id,
      fromStageId: e.fromStageId,
      toStageId: e.toStageId,
      fromStageName: from?.name ?? 'Archived stage',
      toStageName: to?.name ?? 'Archived stage',
      fromStageKey: from?.key ?? 'archived',
      toStageKey: to?.key ?? 'archived',
      reasonCode: e.reasonCode,
      note: e.note,
      trigger: parseTrigger(e.trigger),
      occurredAt: e.occurredAt,
      closedAt: e.closedAt,
      costMicroUsd,
      durationMs,
      costComplete: e.costComplete,
    };
  });

  // Provisional costs for open edges: attribute spend from the edge's own
  // stage instance (not the latest visit to the target stage).
  const openInstanceIds = [
    ...new Set(
      mapped
        .filter((e) => !e.costComplete)
        .map((e) => {
          const raw = edges.find((r) => r.id === e.id);
          return raw?.toStageInstanceId ?? null;
        })
        .filter((id): id is string => id != null),
    ),
  ];
  const openById = new Map<
    string,
    { costMicroUsd: bigint; enteredAt: Date; exitedAt: Date | null }
  >();
  if (openInstanceIds.length > 0) {
    const { inArray } = await import('drizzle-orm');
    const rows = await ctx.db.query.stageInstances.findMany({
      where: inArray(stageInstances.id, openInstanceIds),
    });
    for (const r of rows) {
      openById.set(r.id, {
        costMicroUsd: r.costMicroUsd,
        enteredAt: r.enteredAt,
        exitedAt: r.exitedAt,
      });
    }
  }
  const nowMs = ctx.clock().getTime();
  for (const edge of mapped) {
    if (edge.costComplete) continue;
    const raw = edges.find((r) => r.id === edge.id);
    const instId = raw?.toStageInstanceId;
    if (!instId) continue;
    const openInstance = openById.get(instId);
    // Only still-open instances contribute provisional spend.
    if (openInstance && openInstance.exitedAt == null) {
      (edge as { costMicroUsd: bigint | null }).costMicroUsd =
        openInstance.costMicroUsd;
      (edge as { durationMs: bigint | null }).durationMs = BigInt(
        Math.max(0, nowMs - openInstance.enteredAt.getTime()),
      );
    }
  }

  return ok({
    count: item.loopCount,
    escalated: item.loopEscalated,
    reworkCostMicroUsd: item.reworkCostMicroUsd,
    reworkMs: item.reworkMs,
    spendMicroUsd: item.spendMicroUsd,
    edges: mapped,
    byStagePair: [...byPairMap.values()],
  });
}

export type ReworkStats = {
  projectId: string;
  windowDays: number;
  itemCount: number;
  loopedItemCount: number;
  reworkRate: number;
  meanLoopsWhenLooped: number;
  meanReworkCostMicroUsd: number;
  topStagePairs: Array<{
    fromStageId: string;
    toStageId: string;
    fromStageName: string;
    toStageName: string;
    returnCount: number;
    totalCostMicroUsd: string;
  }>;
  loopDistribution: Array<{ loopCount: number; itemCount: number }>;
};

export async function projectReworkStats(
  ctx: ServiceContext,
  projectId: string,
  windowDays = 30,
): Promise<Result<ReworkStats, CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot read project'));
  }

  const since = new Date(
    ctx.clock().getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  // postgres.js raw-execute rejects Date binds — use ISO strings (B1).
  const sinceIso = since.toISOString();

  const rateRows = await ctx.db.execute(sql`
    select
      count(w.id)::int as item_count,
      count(w.id) filter (where w.loop_count > 0)::int as looped_item_count,
      coalesce(
        avg(w.loop_count) filter (where w.loop_count > 0),
        0
      )::float as mean_loops,
      coalesce(
        avg(w.rework_cost_micro_usd) filter (where w.loop_count > 0),
        0
      )::float as mean_rework_cost
    from work_items w
    where w.project_id = ${projectId}
      and w.archived_at is null
      and w.created_at >= ${sinceIso}::timestamptz
  `);
  const rate = (rateRows as unknown as Array<{
    item_count: number;
    looped_item_count: number;
    mean_loops: number;
    mean_rework_cost: number;
  }>)[0] ?? {
    item_count: 0,
    looped_item_count: 0,
    mean_loops: 0,
    mean_rework_cost: 0,
  };

  const pairRows = await ctx.db.execute(sql`
    select
      le.from_stage_id,
      le.to_stage_id,
      count(*)::int as return_count,
      coalesce(sum(le.cost_micro_usd), 0)::bigint as total_cost
    from loop_edges le
    join work_items w on w.id = le.work_item_id
    where w.project_id = ${projectId}
      and le.occurred_at >= ${sinceIso}::timestamptz
    group by le.from_stage_id, le.to_stage_id
    order by return_count desc
    limit 10
  `);
  const pairs = pairRows as unknown as Array<{
    from_stage_id: string;
    to_stage_id: string;
    return_count: number;
    total_cost: bigint;
  }>;

  const stageIdSet = [
    ...new Set(pairs.flatMap((p) => [p.from_stage_id, p.to_stage_id])),
  ];
  const { inArray } = await import('drizzle-orm');
  const stageList =
    stageIdSet.length === 0
      ? []
      : await ctx.db.query.stages.findMany({
          where: inArray(stages.id, stageIdSet),
        });
  const byId = new Map(stageList.map((s) => [s.id, s]));

  const distRows = await ctx.db.execute(sql`
    select loop_count, count(*)::int as item_count
    from work_items
    where project_id = ${projectId}
      and archived_at is null
    group by loop_count
    order by loop_count
  `);
  const dist = distRows as unknown as Array<{
    loop_count: number;
    item_count: number;
  }>;

  const itemCount = Number(rate.item_count);
  const looped = Number(rate.looped_item_count);

  return ok({
    projectId,
    windowDays,
    itemCount,
    loopedItemCount: looped,
    reworkRate: itemCount === 0 ? 0 : looped / itemCount,
    meanLoopsWhenLooped: Number(rate.mean_loops),
    meanReworkCostMicroUsd: Number(rate.mean_rework_cost),
    topStagePairs: pairs.map((p) => ({
      fromStageId: p.from_stage_id,
      toStageId: p.to_stage_id,
      fromStageName: byId.get(p.from_stage_id)?.name ?? 'Archived',
      toStageName: byId.get(p.to_stage_id)?.name ?? 'Archived',
      returnCount: Number(p.return_count),
      totalCostMicroUsd: String(p.total_cost ?? 0),
    })),
    loopDistribution: dist.map((d) => ({
      loopCount: Number(d.loop_count),
      itemCount: Number(d.item_count),
    })),
  });
}

/** Backfill visit_index / loop_edges / counters. Safe to re-run: absolute recomputes + dedupe. */
export async function backfillLoopsForProject(
  db: Db,
  projectId: string,
): Promise<{ visitUpdated: number; edgesCreated: number }> {
  const visit = await db.execute(sql`
    with ranked as (
      select
        si.id,
        row_number() over (
          partition by si.work_item_id, si.stage_id
          order by si.seq asc, si.entered_at asc, si.id asc
        ) as vi
      from stage_instances si
      join work_items w on w.id = si.work_item_id
      where w.project_id = ${projectId}
    )
    update stage_instances si
    set
      visit_index = ranked.vi,
      is_rework = (ranked.vi > 1)
    from ranked
    where si.id = ranked.id
      and (
        si.visit_index is distinct from ranked.vi
        or si.is_rework is distinct from (ranked.vi > 1)
      )
    returning si.id
  `);
  const visitArr = visit as unknown as Array<{ id: string }>;

  await db.execute(sql`
    with candidates as (
      select
        t.id as transition_id,
        t.work_item_id,
        t.from_stage_id,
        t.to_stage_id,
        t.created_at,
        (
          select si.seq
          from stage_instances si
          where si.work_item_id = t.work_item_id
            and si.stage_id = t.to_stage_id
            and si.entered_at <= t.created_at + interval '1 second'
          order by si.seq desc
          limit 1
        ) as entered_seq
      from transitions t
      join work_items w on w.id = t.work_item_id
      where w.project_id = ${projectId}
        and t.direction = 'backward'
        and t.from_stage_id is not null
        and t.is_return_edge = false
    ),
    confirmed as (
      select c.*
      from candidates c
      where c.entered_seq is not null
        and exists (
          select 1 from stage_instances prior
          where prior.work_item_id = c.work_item_id
            and prior.stage_id = c.to_stage_id
            and prior.seq < c.entered_seq
        )
    )
    update transitions t
    set is_return_edge = true
    from confirmed c
    where t.id = c.transition_id
  `);

  const edges = await db.execute(sql`
    insert into loop_edges (
      id, work_item_id, transition_id, from_stage_id, to_stage_id,
      to_stage_instance_id, reason_code, note, trigger, occurred_at,
      created_at, cost_complete
    )
    select
      md5(t.id::text || ':loop_edge')::uuid,
      t.work_item_id,
      t.id,
      t.from_stage_id,
      t.to_stage_id,
      (
        select si.id
        from stage_instances si
        where si.work_item_id = t.work_item_id
          and si.stage_id = t.to_stage_id
          and si.entered_at <= t.created_at + interval '1 second'
        order by si.seq desc
        limit 1
      ),
      coalesce(nullif(t.reason_code, ''), 'unknown'),
      t.note,
      jsonb_build_object('kind', 'backfill', 'by', 'backfillLoopsForProject'),
      t.created_at,
      t.created_at,
      false
    from transitions t
    join work_items w on w.id = t.work_item_id
    where w.project_id = ${projectId}
      and t.is_return_edge = true
      and t.from_stage_id is not null
      and not exists (
        select 1 from loop_edges le where le.transition_id = t.id
      )
    returning id
  `);
  const edgeArr = edges as unknown as Array<{ id: string }>;

  await db.execute(sql`
    update transitions t
    set loop_edge_id = le.id
    from loop_edges le
    join work_items w on w.id = le.work_item_id
    where le.transition_id = t.id
      and w.project_id = ${projectId}
      and t.loop_edge_id is distinct from le.id
  `);

  await db.execute(sql`
    update work_items w
    set
      loop_count = coalesce((
        select count(*)::int from loop_edges le where le.work_item_id = w.id
      ), 0),
      rework_cost_micro_usd = coalesce((
        select sum(si.cost_micro_usd)::bigint
        from stage_instances si
        where si.work_item_id = w.id and si.visit_index > 1
      ), 0),
      rework_ms = coalesce((
        select sum(
          greatest(
            0,
            (extract(epoch from (si.exited_at - si.entered_at)) * 1000)::bigint
          )
        )::bigint
        from stage_instances si
        where si.work_item_id = w.id
          and si.visit_index > 1
          and si.exited_at is not null
      ), 0),
      updated_at = now()
    where w.project_id = ${projectId}
      and (
        w.loop_count is distinct from coalesce((
          select count(*)::int from loop_edges le where le.work_item_id = w.id
        ), 0)
        or w.rework_ms is distinct from coalesce((
          select sum(
            greatest(
              0,
              (extract(epoch from (si.exited_at - si.entered_at)) * 1000)::bigint
            )
          )::bigint
          from stage_instances si
          where si.work_item_id = w.id
            and si.visit_index > 1
            and si.exited_at is not null
        ), 0)
        or w.rework_cost_micro_usd is distinct from coalesce((
          select sum(si.cost_micro_usd)::bigint
          from stage_instances si
          where si.work_item_id = w.id and si.visit_index > 1
        ), 0)
      )
  `);

  return {
    visitUpdated: visitArr.length,
    edgesCreated: edgeArr.length,
  };
}
