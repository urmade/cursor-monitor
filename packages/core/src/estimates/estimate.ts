import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Complexity, CostEstimate } from '@nexus/contracts';
import {
  estimateCache,
  labels,
  projects,
  stages,
  workItemLabels,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { parseProjectBudgetSettings } from '../budgets/settings';
import {
  buildColdStartEstimate,
  buildRangeEstimate,
  CACHE_TTL_MS,
  cacheKey,
  parseEstimate,
  selectComparables,
  serializeEstimate,
  type ComparableItem,
} from './math';

async function pipelineFingerprint(
  ctx: ServiceContext,
  projectId: string,
): Promise<string> {
  const rows = await ctx.db.query.stages.findMany({
    where: and(eq(stages.projectId, projectId), isNull(stages.archivedAt)),
  });
  return rows
    .map((s) => s.key)
    .sort()
    .join('|');
}

async function labelKeysForItems(
  ctx: ServiceContext,
  itemIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (itemIds.length === 0) return map;
  const rows = await ctx.db
    .select({
      workItemId: workItemLabels.workItemId,
      key: labels.key,
    })
    .from(workItemLabels)
    .innerJoin(labels, eq(labels.id, workItemLabels.labelId))
    .where(inArray(workItemLabels.workItemId, itemIds));
  for (const r of rows) {
    const list = map.get(r.workItemId) ?? [];
    list.push(r.key);
    map.set(r.workItemId, list);
  }
  return map;
}

/** Load a project only if it belongs to ctx.orgId (B1). */
async function loadOrgProject(ctx: ServiceContext, projectId: string) {
  return ctx.db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, ctx.orgId),
      isNull(projects.archivedAt),
    ),
  });
}

/**
 * Completed = current stage is terminal and not abandoned (archived).
 * Pool is always scoped to opts.orgId / ctx.orgId.
 */
export async function loadComparablePool(
  ctx: ServiceContext,
  opts: { orgId: string; projectId?: string },
): Promise<ComparableItem[]> {
  if (opts.orgId !== ctx.orgId) {
    return [];
  }

  const orgProjects = await ctx.db.query.projects.findMany({
    where: and(eq(projects.orgId, opts.orgId), isNull(projects.archivedAt)),
  });

  const allProjectIds = orgProjects.map((p) => p.id);
  if (allProjectIds.length === 0) return [];

  const fingerprints = new Map<string, string>();
  for (const p of orgProjects) {
    fingerprints.set(p.id, await pipelineFingerprint(ctx, p.id));
  }

  const items = await ctx.db
    .select({
      id: workItems.id,
      projectId: workItems.projectId,
      complexity: workItems.complexity,
      spendMicroUsd: workItems.spendMicroUsd,
      spendSource: workItems.spendSource,
      updatedAt: workItems.updatedAt,
      isTerminal: stages.isTerminal,
    })
    .from(workItems)
    .innerJoin(stages, eq(stages.id, workItems.currentStageId))
    .where(
      and(
        inArray(workItems.projectId, allProjectIds),
        isNull(workItems.archivedAt),
        eq(stages.isTerminal, true),
      ),
    );

  const withComplexity = items.filter(
    (i): i is typeof i & { complexity: Complexity } =>
      i.complexity === 'low' ||
      i.complexity === 'medium' ||
      i.complexity === 'high',
  );

  const labelMap = await labelKeysForItems(
    ctx,
    withComplexity.map((i) => i.id),
  );

  return withComplexity.map((i) => ({
    id: i.id,
    projectId: i.projectId,
    complexity: i.complexity,
    spendMicroUsd: i.spendMicroUsd,
    // Phase 5 allows null spend_source until first capture; treat as estimated.
    spendSource: i.spendSource ?? 'estimated',
    labelKeys: labelMap.get(i.id) ?? [],
    pipelineFingerprint: fingerprints.get(i.projectId) ?? '',
    completedAt: i.updatedAt,
  }));
}

async function defaultBudgetFor(
  ctx: ServiceContext,
  projectId: string,
  complexity: Complexity,
): Promise<bigint | null> {
  const project = await loadOrgProject(ctx, projectId);
  if (!project) return null;
  const settings = parseProjectBudgetSettings(project.settings ?? {});
  return settings.complexityDefaults[complexity].hardMicroUsd;
}

export async function estimateForNewItem(
  ctx: ServiceContext,
  input: {
    projectId: string;
    complexity: Complexity;
    labelKeys?: string[];
    asOf?: Date;
    bypassCache?: boolean;
  },
): Promise<Result<CostEstimate, CoreError>> {
  // B1: tenant check first — membership must not be the only guard
  // (system actors bypass can(); a wrong orgId must still 404).
  const project = await loadOrgProject(ctx, input.projectId);
  if (!project) return err(coreError('not_found', 'Project not found'));

  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }

  const enabled = await ctx.flags.isEnabled('p9.estimates', input.projectId);
  if (!enabled) {
    const def = await defaultBudgetFor(ctx, input.projectId, input.complexity);
    if (def == null) return err(coreError('not_found', 'Project not found'));
    return ok(
      buildColdStartEstimate({
        n: 0,
        complexity: input.complexity,
        defaultBudgetMicroUsd: def,
        projectName: project.name,
        reason: 'flag_disabled',
      }),
    );
  }

  const labelKeys = input.labelKeys ?? [];
  const key = cacheKey({
    orgId: ctx.orgId,
    projectId: input.projectId,
    complexity: input.complexity,
    labelKeys,
  });

  if (!input.bypassCache && !input.asOf) {
    const cached = await ctx.db.query.estimateCache.findFirst({
      where: eq(estimateCache.key, key),
    });
    if (cached && cached.expiresAt > new Date()) {
      try {
        return ok(parseEstimate(cached.estimate));
      } catch {
        // fall through and recompute
      }
    }
  }

  const pool = await loadComparablePool(ctx, {
    orgId: ctx.orgId,
    projectId: input.projectId,
  });
  const fingerprint = await pipelineFingerprint(ctx, input.projectId);
  const selection = selectComparables(pool, {
    projectId: input.projectId,
    complexity: input.complexity,
    labelKeys,
    pipelineFingerprint: fingerprint,
    before: input.asOf,
  });

  let estimate: CostEstimate;
  if (selection.tier === 4) {
    const def = await defaultBudgetFor(ctx, input.projectId, input.complexity);
    if (def == null) return err(coreError('not_found', 'Project not found'));
    estimate = buildColdStartEstimate({
      n: selection.items.length,
      complexity: input.complexity,
      defaultBudgetMicroUsd: def,
      projectName: project.name,
      rangeAppearsAfter: selection.nextThreshold,
    });
  } else {
    estimate = buildRangeEstimate({
      tier: selection.tier,
      items: selection.items,
      projectName: project.name,
      complexity: input.complexity,
    });
  }

  if (!input.asOf) {
    const now = new Date();
    await ctx.db
      .insert(estimateCache)
      .values({
        key,
        estimate: serializeEstimate(estimate),
        computedAt: now,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: estimateCache.key,
        set: {
          estimate: serializeEstimate(estimate),
          computedAt: now,
          expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
          updatedAt: now,
        },
      });
  }

  return ok(estimate);
}

export async function estimateForItem(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<CostEstimate, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, workItemId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  // B1: work item's project must be in this org.
  const project = await loadOrgProject(ctx, item.projectId);
  if (!project) return err(coreError('not_found', 'Work item not found'));

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

  if (item.estimateAtCreation) {
    try {
      return ok(parseEstimate(item.estimateAtCreation));
    } catch {
      // recompute
    }
  }

  if (!item.complexity) {
    return err(coreError('validation', 'Work item has no complexity'));
  }

  const labelMap = await labelKeysForItems(ctx, [workItemId]);
  return estimateForNewItem(ctx, {
    projectId: item.projectId,
    complexity: item.complexity,
    labelKeys: labelMap.get(workItemId) ?? [],
  });
}

export async function snapshotEstimateOnCreate(
  ctx: ServiceContext,
  workItemId: string,
  estimate: CostEstimate,
): Promise<void> {
  const tier = estimate.kind === 'range' ? estimate.tier : 4;
  await ctx.db
    .update(workItems)
    .set({
      estimateAtCreation: serializeEstimate(estimate),
      estimateTier: tier,
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, workItemId));
}

/** Drop cache entries for a project in this org (called when an item completes). */
export async function invalidateEstimateCacheForProject(
  ctx: ServiceContext,
  projectId: string,
): Promise<void> {
  // Match both new org-scoped keys and any legacy keys without org (safety).
  await ctx.db.execute(
    sql`delete from estimate_cache where key like ${`est:${ctx.orgId}:${projectId}:%`} or key like ${`est:${projectId}:%`}`,
  );
}
