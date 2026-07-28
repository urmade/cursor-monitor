import { CursorAdminClient } from '@nexus/cursor-client';
import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { costRollupChecks, newId, runs, workItems } from '@nexus/db';
import type { ServiceContext } from '../context';
import { fromCents } from './money';
import { applyCostRollups } from './rollups';
import { err, ok, type Result } from '../result';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';

export type ReconcileSummary = {
  upgraded: number;
  skipped: number;
  unavailable: boolean;
  message?: string;
};

function adminApiKey(): string | undefined {
  return (
    process.env.CURSOR_ADMIN_API_KEY ??
    process.env.CURSOR_TEAM_API_KEY ??
    undefined
  );
}

export async function reconcileWindow(
  ctx: ServiceContext,
  input: { from: Date; to: Date },
): Promise<Result<ReconcileSummary, CoreError>> {
  const key = adminApiKey();
  if (!key) {
    return ok({
      upgraded: 0,
      skipped: 0,
      unavailable: true,
      message: 'Admin API key not configured',
    });
  }

  const client = new CursorAdminClient({ apiKey: key });
  let events: Array<{
    cloudAgentId?: string;
    usageUuid?: string;
    chargedCents?: number;
    totalTokens?: number;
  }> = [];

  try {
    let cursor: string | undefined;
    do {
      const page = await client.filteredUsageEvents({
        startDate: input.from.toISOString(),
        endDate: input.to.toISOString(),
        pageSize: 100,
        cursor,
      });
      const batch = page.events ?? page.usageEvents ?? [];
      events = events.concat(batch as typeof events);
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : typeof page.cursor === 'string' ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('401') || msg.includes('403') || msg.includes('Invalid')) {
      return ok({
        upgraded: 0,
        skipped: 0,
        unavailable: true,
        message: 'Admin reconciliation unavailable on this tier',
      });
    }
    return err(coreError('provider_error', msg));
  }

  const terminalRuns = await ctx.db.query.runs.findMany({
    where: and(
      gte(runs.terminalAt, input.from),
      lte(runs.terminalAt, input.to),
      inArray(runs.status, [
        'completed',
        'completed_no_report',
        'failed',
        'cancelled',
        'expired',
        'launch_failed',
      ]),
      or(
        eq(runs.costSource, 'estimated'),
        isNull(runs.costSource),
        eq(runs.costSource, 'provider'),
      ),
    ),
    limit: 500,
  });

  let upgraded = 0;
  let skipped = 0;

  const sharedAgentRuns = new Map<string, number>();
  for (const r of terminalRuns) {
    if (r.providerAgentId && !r.usageUuid) {
      sharedAgentRuns.set(
        r.providerAgentId,
        (sharedAgentRuns.get(r.providerAgentId) ?? 0) + 1,
      );
    }
  }

  for (const run of terminalRuns) {
    if (!run.providerAgentId) {
      skipped += 1;
      continue;
    }
    const match = events.find((ev) => {
      if (run.usageUuid) {
        return Boolean(ev.usageUuid && ev.usageUuid === run.usageUuid);
      }
      return ev.cloudAgentId === run.providerAgentId;
    });
    const matchedByUsageUuid = Boolean(
      match && run.usageUuid && match.usageUuid === run.usageUuid,
    );
    if (
      !matchedByUsageUuid &&
      run.providerAgentId &&
      (sharedAgentRuns.get(run.providerAgentId) ?? 0) > 1
    ) {
      skipped += 1;
      continue;
    }
    if (!match?.chargedCents && match?.chargedCents !== 0) {
      skipped += 1;
      continue;
    }

    const prior = run.costMicroUsd ?? BigInt(0);
    const next = fromCents(match.chargedCents);
    if (run.costSource === 'admin_reconciled' && prior === next) {
      skipped += 1;
      continue;
    }

    const item = await ctx.db.query.workItems.findFirst({
      where: eq(workItems.id, run.workItemId),
    });
    if (!item) {
      skipped += 1;
      continue;
    }

    const delta = next - prior;
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({
          costActualMicroUsd: next,
          costMicroUsd: next,
          costSource: 'admin_reconciled',
          reconciledAt: new Date(),
          allocationMethod: matchedByUsageUuid
            ? 'exact'
            : 'agent_attributed',
        })
        .where(eq(runs.id, run.id));

      if (delta !== BigInt(0)) {
        await applyCostRollups(tx, {
          runId: run.id,
          workItemId: run.workItemId,
          stageInstanceId: run.stageInstanceId,
          projectId: item.projectId,
          deltaMicro: delta,
          costSource: 'admin_reconciled',
        });
      }
    });

    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'cost.reconciled',
      subjectType: 'run',
      subjectId: run.id,
      actor: { kind: 'system', reason: 'reconcile_costs_admin' },
      payload: {
        prior: prior.toString(),
        next: next.toString(),
        delta: delta.toString(),
      },
    });

    upgraded += 1;
  }

  return ok({ upgraded, skipped, unavailable: false });
}

export async function recomputeCostRollupsJob(
  ctx: ServiceContext,
): Promise<{ driftReports: number }> {
  const { projects } = await import('@nexus/db');
  const all = await ctx.db.query.projects.findMany({
    where: isNull(projects.archivedAt),
  });

  const { recomputeRollupsForProject } = await import('./rollups');
  let driftReports = 0;

  for (const p of all) {
    const { drift } = await recomputeRollupsForProject(ctx.db, p.id);
    for (const d of drift) {
      await ctx.db.insert(costRollupChecks).values({
        id: newId(),
        scope: d.scope,
        subjectId: d.subjectId,
        storedMicroUsd: d.storedMicroUsd,
        recomputedMicroUsd: d.recomputedMicroUsd,
        driftMicroUsd: d.drift,
      });
      driftReports += 1;
      await emit(ctx.db, {
        orgId: ctx.orgId,
        projectId: p.id,
        type: 'cost.rollup_drift',
        subjectType: 'project',
        subjectId: p.id,
        actor: { kind: 'system', reason: 'recompute_cost_rollups' },
        payload: {
          scope: d.scope,
          subjectId: d.subjectId,
          driftMicroUsd: d.drift.toString(),
        },
      });
    }
  }

  return { driftReports };
}
