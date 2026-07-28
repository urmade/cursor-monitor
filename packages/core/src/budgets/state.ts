import { and, eq, inArray, sql } from 'drizzle-orm';
import { ACTIVE_RUN_STATUSES } from '@nexus/contracts';
import { budgetEvents, newId, projects, runs, workItems } from '@nexus/db';
import type { ServiceContext } from '../context';
import type { Db } from '@nexus/db';
import {
  hardBudgetForComplexity,
  parseProjectBudgetSettings,
  type ProjectBudgetSettings,
} from './settings';
import type { MicroUsd } from '../cost/money';

export type BudgetLevelState = 'ok' | 'warn' | 'blocked';

export type BudgetState = {
  item: {
    budgetMicro: MicroUsd | null;
    softMicro: MicroUsd | null;
    spentMicro: MicroUsd;
    reservedMicro: MicroUsd;
    ratio: number | null;
    state: BudgetLevelState;
  };
  project: {
    capMicro: MicroUsd | null;
    spentMicro: MicroUsd;
    reservedMicro: MicroUsd;
    ratio: number | null;
    state: BudgetLevelState;
  };
  reservations: { activeRuns: number; reservePerRun: MicroUsd };
};

function ratioOf(spent: MicroUsd, cap: MicroUsd | null): number | null {
  if (cap == null || cap === BigInt(0)) return null;
  return Number(spent) / Number(cap);
}

export function levelFromRatio(
  ratio: number | null,
  softRatio: number,
  hardRatio: number,
): BudgetLevelState {
  if (ratio == null) return 'ok';
  if (ratio >= hardRatio) return 'blocked';
  if (ratio >= softRatio) return 'warn';
  return 'ok';
}

export async function countReservedMicro(
  ctx: ServiceContext,
  projectId: string,
  reservePerRun: MicroUsd,
): Promise<{ count: number; total: MicroUsd }> {
  const rows = await ctx.db.execute(sql`
    select count(*)::int as c
    from runs r
    join work_items w on w.id = r.work_item_id
    where w.project_id = ${projectId}
      and r.status in ('pending','launched','running')
  `);
  const arr = rows as unknown as Array<{ c: number }>;
  const count = Number(arr[0]?.c ?? 0);
  return { count, total: BigInt(count) * reservePerRun };
}

export async function computeBudgetState(
  ctx: ServiceContext,
  workItemId: string,
): Promise<BudgetState | null> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return null;

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  if (!project) return null;

  const settings = parseProjectBudgetSettings(project.settings as Record<string, unknown>);
  const budgetSettings = settings;

  const itemBudget =
    item.budgetMicroUsd ??
    hardBudgetForComplexity(budgetSettings, item.complexity ?? null);

  const soft =
    item.complexity != null
      ? budgetSettings.complexityDefaults[item.complexity].softMicroUsd
      : null;

  const { count, total: reservedProject } = await countReservedMicro(
    ctx,
    item.projectId,
    settings.reserveMicroUsdPerRun,
  );

  const itemReservedRows = await ctx.db.query.runs.findMany({
    where: and(
      eq(runs.workItemId, workItemId),
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
    ),
  });
  const itemReserved = BigInt(itemReservedRows.length) * settings.reserveMicroUsdPerRun;

  const itemSpent = item.spendMicroUsd + itemReserved;
  const itemRatio = ratioOf(itemSpent, itemBudget);
  const itemSoftRatio =
    itemBudget && soft
      ? Number(soft) / Number(itemBudget)
      : 0.8;
  const itemState =
    item.pausedReason === 'budget'
      ? 'blocked'
      : levelFromRatio(itemRatio, itemSoftRatio, 1);

  const projectSpent = project.spendMicroUsd + reservedProject;
  const projectRatio = ratioOf(projectSpent, settings.burnCapMicroUsd);
  const projectState = levelFromRatio(
    projectRatio,
    settings.burnSoftRatio,
    1,
  );

  return {
    item: {
      budgetMicro: itemBudget,
      softMicro: soft,
      spentMicro: item.spendMicroUsd,
      reservedMicro: itemReserved,
      ratio: itemRatio,
      state: itemState,
    },
    project: {
      capMicro: settings.burnCapMicroUsd,
      spentMicro: project.spendMicroUsd,
      reservedMicro: reservedProject,
      ratio: projectRatio,
      state: projectState,
    },
    reservations: {
      activeRuns: count,
      reservePerRun: settings.reserveMicroUsdPerRun,
    },
  };
}

export async function recordBudgetEvent(
  tx: Pick<Db, 'insert'>,
  input: {
    projectId: string;
    workItemId?: string | null;
    kind: string;
    scope: 'item' | 'project';
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    actor: Record<string, unknown>;
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(budgetEvents).values({
    id: newId(),
    projectId: input.projectId,
    workItemId: input.workItemId ?? null,
    kind: input.kind,
    scope: input.scope,
    before: input.before,
    after: input.after,
    actor: input.actor,
    reason: input.reason ?? null,
  });
}

export function projectBudgetSettings(project: {
  settings: Record<string, unknown>;
}): ProjectBudgetSettings {
  return parseProjectBudgetSettings(project.settings);
}
