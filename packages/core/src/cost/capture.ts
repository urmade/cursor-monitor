import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { modelPrices, runs, workItems } from '@nexus/db';
import type { CostSource } from '@nexus/db';
import type { ServiceContext } from '../context';
import { emit } from '../events/emit';
import { coreError, type CoreError } from '../errors';
import { err, ok, type Result } from '../result';
import { fromCents, type MicroUsd } from './money';
import { estimateFromPriceRow, type TokenVector } from './prices';
import { applyCostRollups } from './rollups';

export type RunTokens = Record<string, unknown> | null;

function parseTokenVector(tokens: RunTokens): TokenVector {
  if (!tokens) return {};
  const t = tokens as Record<string, unknown>;
  return {
    input: typeof t.input === 'number' ? t.input : undefined,
    output: typeof t.output === 'number' ? t.output : undefined,
    cacheWrite: typeof t.cacheWrite === 'number' ? t.cacheWrite : undefined,
    cacheRead: typeof t.cacheRead === 'number' ? t.cacheRead : undefined,
  };
}

function chargedCentsFromTokens(tokens: RunTokens): number | undefined {
  if (!tokens) return undefined;
  const c = (tokens as { chargedCents?: unknown }).chargedCents;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
}

export async function estimateRunCost(
  ctx: ServiceContext,
  runId: string,
): Promise<
  Result<
    { micro: MicroUsd; priceRowId: string | null; modelUnknown: boolean },
    CoreError
  >
> {
  const run = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return err(coreError('not_found', 'Run not found'));

  const at = run.launchedAt ?? run.createdAt;
  const model = (run.model ?? '').trim() || 'default';
  const rows = await ctx.db.query.modelPrices.findMany({
    where: and(eq(modelPrices.model, model), lte(modelPrices.effectiveFrom, at)),
    orderBy: [desc(modelPrices.effectiveFrom)],
    limit: 1,
  });
  if (!rows[0]) {
    return ok({ micro: BigInt(0), priceRowId: null, modelUnknown: model !== 'default' });
  }
  const row = rows[0];
  const micro = estimateFromPriceRow(row, parseTokenVector(run.tokens as RunTokens));
  return ok({
    micro,
    priceRowId: row.id,
    modelUnknown: false,
  });
}

export async function captureRunCostAtCloseOut(
  ctx: ServiceContext,
  runId: string,
): Promise<Result<{ costMicro: MicroUsd; costSource: CostSource }, CoreError>> {
  const run = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return err(coreError('not_found', 'Run not found'));

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, run.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  if (run.costMicroUsd != null) {
    return ok({
      costMicro: run.costMicroUsd,
      costSource: (run.costSource ?? 'estimated') as CostSource,
    });
  }

  // Test-only fault injection (set by closeOut.capture-failure.test.ts only).
  if (process.env.NEXUS_TEST_FAULT_CAPTURE === '1') {
    return err(coreError('invariant', 'simulated capture fault'));
  }

  const estimate = await estimateRunCost(ctx, runId);
  if (!estimate.ok) return estimate;

  const estimateMicro = estimate.value.micro;
  const priceRowId = estimate.value.priceRowId;
  const modelUnknown = estimate.value.modelUnknown;

  const charged = chargedCentsFromTokens(run.tokens as RunTokens);
  let costMicro: MicroUsd;
  let costSource: CostSource;
  let actualMicro: MicroUsd | null = null;

  if (charged !== undefined) {
    actualMicro = fromCents(charged);
    costMicro = actualMicro;
    costSource = 'provider';
  } else {
    costMicro = estimateMicro;
    costSource = 'estimated';
  }

  let captured = false;

  await ctx.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(runs)
      .set({
        costEstimateMicroUsd: estimateMicro,
        costActualMicroUsd: actualMicro,
        costMicroUsd: costMicro,
        costSource,
        priceRowId,
      })
      .where(and(eq(runs.id, runId), isNull(runs.costMicroUsd)))
      .returning({ id: runs.id });

    if (!claimed) {
      return;
    }

    captured = true;

    await applyCostRollups(tx, {
      runId,
      workItemId: run.workItemId,
      stageInstanceId: run.stageInstanceId,
      projectId: item.projectId,
      deltaMicro: costMicro,
      costSource,
    });
  });

  if (!captured) {
    const again = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (again?.costMicroUsd != null) {
      return ok({
        costMicro: again.costMicroUsd,
        costSource: (again.costSource ?? 'estimated') as CostSource,
      });
    }
    return err(coreError('conflict', 'Run cost capture lost race'));
  }

  const warnings: string[] = [];
  if (modelUnknown && costSource === 'estimated') {
    warnings.push('price.model_unknown');
  }

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: costSource === 'provider' ? 'cost.provider' : 'cost.estimated',
    subjectType: 'run',
    subjectId: runId,
    actor: { kind: 'system', reason: 'captureRunCost' },
    payload: {
      costMicroUsd: costMicro.toString(),
      costSource,
      estimateMicroUsd: estimateMicro.toString(),
      warnings,
    },
  });

  if (warnings.length) {
    try {
      const { persistBudgetWarning } = await import('../budgets/warnings');
      await persistBudgetWarning(ctx, {
        workItemId: run.workItemId,
        code: 'price.model_unknown',
        message: 'Run cost estimated with unknown model — price may be zero until model is priced.',
        stageInstanceId: run.stageInstanceId,
      });
    } catch {
      // best-effort
    }
  }

  try {
    const { onRunCostCaptured } = await import('../budgets/thresholds');
    await onRunCostCaptured(ctx, {
      workItemId: run.workItemId,
      projectId: item.projectId,
    });
  } catch {
    // best-effort
  }

  return ok({ costMicro, costSource });
}
