import { eq, sql } from 'drizzle-orm';
import {
  projects,
  stageInstances,
  workItems,
  type CostSource,
} from '@nexus/db';
import type { Db } from '@nexus/db';
import type { MicroUsd } from './money';

export function mergeCostSource(a: CostSource | null, b: CostSource): CostSource {
  if (!a || a === b) return b;
  if (a === 'mixed' || b === 'mixed') return 'mixed';
  return 'mixed';
}

export function mergeSpendSource(
  existing: string | null | undefined,
  incoming: CostSource,
): CostSource {
  if (!existing) return incoming;
  const cur = existing as CostSource;
  return mergeCostSource(cur, incoming);
}

/** Atomic rollup increments — never read-modify-write. */
export async function applyCostRollups(
  db: Db,
  input: {
    runId: string;
    workItemId: string;
    stageInstanceId: string;
    projectId: string;
    deltaMicro: MicroUsd;
    costSource: CostSource;
  },
): Promise<void> {
  const delta = input.deltaMicro;
  if (delta === BigInt(0)) return;

  await db
    .update(stageInstances)
    .set({
      costMicroUsd: sql`${stageInstances.costMicroUsd} + ${delta}`,
    })
    .where(eq(stageInstances.id, input.stageInstanceId));

  const item = await db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });
  const nextItemSource = mergeSpendSource(item?.spendSource, input.costSource);

  await db
    .update(workItems)
    .set({
      spendMicroUsd: sql`${workItems.spendMicroUsd} + ${delta}`,
      spendSource: nextItemSource,
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, input.workItemId));

  await db
    .update(projects)
    .set({
      spendMicroUsd: sql`${projects.spendMicroUsd} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, input.projectId));
}

export type RollupScope = 'run' | 'stage_instance' | 'work_item' | 'project';

export async function recomputeRollupsForProject(
  db: Db,
  projectId: string,
): Promise<{
  drift: Array<{
    scope: string;
    subjectId: string;
    drift: MicroUsd;
    storedMicroUsd: MicroUsd;
    recomputedMicroUsd: MicroUsd;
  }>;
}> {
  const drift: Array<{
    scope: string;
    subjectId: string;
    drift: MicroUsd;
    storedMicroUsd: MicroUsd;
    recomputedMicroUsd: MicroUsd;
  }> = [];

  const stageSums = await db.execute(sql`
    select si.id,
      si.cost_micro_usd::bigint as stored,
      coalesce(sum(r.cost_micro_usd), 0)::bigint as recomputed
    from stage_instances si
    join work_items w on w.id = si.work_item_id
    left join runs r on r.stage_instance_id = si.id
      and r.status in ('completed','completed_no_report','failed','cancelled','expired','launch_failed')
    where w.project_id = ${projectId}
    group by si.id, si.cost_micro_usd
  `);
  const stagesArr = stageSums as unknown as Array<{
    id: string;
    stored: bigint;
    recomputed: bigint;
  }>;

  const itemSums = await db.execute(sql`
    select w.id,
      w.spend_micro_usd::bigint as stored,
      coalesce(sum(r.cost_micro_usd), 0)::bigint as recomputed
    from work_items w
    left join runs r on r.work_item_id = w.id
      and r.status in ('completed','completed_no_report','failed','cancelled','expired','launch_failed')
    where w.project_id = ${projectId}
    group by w.id, w.spend_micro_usd
  `);
  const itemsArr = itemSums as unknown as Array<{
    id: string;
    stored: bigint;
    recomputed: bigint;
  }>;

  const projectRow = await db.execute(sql`
    select p.spend_micro_usd::bigint as stored,
      coalesce(sum(r.cost_micro_usd), 0)::bigint as recomputed
    from projects p
    left join work_items w on w.project_id = p.id
    left join runs r on r.work_item_id = w.id
      and r.status in ('completed','completed_no_report','failed','cancelled','expired','launch_failed')
    where p.id = ${projectId}
    group by p.id, p.spend_micro_usd
  `);
  const projArr = projectRow as unknown as Array<{
    stored: bigint;
    recomputed: bigint;
  }>;

  for (const row of stagesArr) {
    const stored = BigInt(row.stored);
    const recomputed = BigInt(row.recomputed);
    const d = stored - recomputed;
    if (d !== BigInt(0)) {
      drift.push({
        scope: 'stage_instance',
        subjectId: row.id,
        drift: d,
        storedMicroUsd: stored,
        recomputedMicroUsd: recomputed,
      });
    }
  }

  for (const row of itemsArr) {
    const stored = BigInt(row.stored);
    const recomputed = BigInt(row.recomputed);
    const d = stored - recomputed;
    if (d !== BigInt(0)) {
      drift.push({
        scope: 'work_item',
        subjectId: row.id,
        drift: d,
        storedMicroUsd: stored,
        recomputedMicroUsd: recomputed,
      });
    }
  }
  if (projArr[0]) {
    const stored = BigInt(projArr[0].stored);
    const recomputed = BigInt(projArr[0].recomputed);
    const d = stored - recomputed;
    if (d !== BigInt(0)) {
      drift.push({
        scope: 'project',
        subjectId: projectId,
        drift: d,
        storedMicroUsd: stored,
        recomputedMicroUsd: recomputed,
      });
    }
  }
  return { drift };
}
