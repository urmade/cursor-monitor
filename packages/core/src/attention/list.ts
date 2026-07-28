import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  AttentionItemSchema,
  type AttentionKind,
  type InFlightSummary,
} from '@nexus/contracts';
import { attentionItems, workItems } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { describeScore } from './score';
import { decodeInboxCursor } from './list-cursor';
import { listMemberProjectIds } from './sources';

export { decodeInboxCursor };

const KIND_ORDER: AttentionKind[] = [
  'blocking_question',
  'budget_block',
  'run_failed',
  'run_completed_no_report',
  'pending_approval',
  'loop_escalation',
  'external_block',
];

export type AttentionPage = {
  groups: Array<{ kind: AttentionKind; items: ReturnType<typeof mapRow>[] }>;
  nextCursor: string | null;
  totalOpen: number;
};

function mapRow(
  row: typeof attentionItems.$inferSelect,
  workItemKey: string,
  canAct: boolean,
) {
  const scoreExplain = row.scoreExplain as Record<string, number>;
  const parsed = AttentionItemSchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    workItemId: row.workItemId,
    workItemKey,
    kind: row.kind,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    title: row.title,
    why: row.why,
    askedOf: row.askedOf,
    status: row.status,
    score: row.score,
    scoreExplain,
    actions: row.actions,
    snoozedUntil: row.snoozedUntil,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolution: row.resolution,
    meta: { canAct, scoreDescription: describeScore(scoreExplain as never, row.kind as AttentionKind) },
  });
  if (!parsed.success) {
    return {
      id: row.id,
      projectId: row.projectId,
      workItemId: row.workItemId,
      workItemKey,
      kind: row.kind as AttentionKind,
      title: row.title,
      why: row.why,
      score: row.score,
      actions: row.actions,
      canAct,
    };
  }
  return parsed.data;
}

async function filterProjectIds(
  ctx: ServiceContext,
  projectIds?: string[],
): Promise<Result<string[], CoreError>> {
  if (ctx.actor.kind !== 'human') {
    return err(coreError('forbidden', 'Inbox requires human actor'));
  }
  const member = await listMemberProjectIds(ctx, ctx.actor.userId);
  if (projectIds && projectIds.length > 0) {
    const allowed = projectIds.filter((id) => member.includes(id));
    return ok(allowed);
  }
  return ok(member);
}

function encodeInboxCursor(row: {
  score: number;
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      s: row.score,
      t: row.createdAt.toISOString(),
      i: row.id,
    }),
  ).toString('base64url');
}

export async function listInbox(
  ctx: ServiceContext,
  opts: {
    projectIds?: string[];
    kinds?: AttentionKind[];
    limit?: number;
    cursor?: string | null;
    includeSnoozed?: boolean;
  },
): Promise<Result<AttentionPage, CoreError>> {
  const projectsR = await filterProjectIds(ctx, opts.projectIds);
  if (!projectsR.ok) return projectsR;
  const pids = projectsR.value;
  if (pids.length === 0) {
    return ok({ groups: [], nextCursor: null, totalOpen: 0 });
  }

  const now = ctx.clock();
  const nowIso = now.toISOString();
  const baseConditions = [
    eq(attentionItems.status, 'open'),
    inArray(attentionItems.projectId, pids),
  ];
  if (!opts.includeSnoozed) {
    baseConditions.push(
      sql`(${attentionItems.snoozedUntil} is null or ${attentionItems.snoozedUntil} <= ${nowIso}::timestamptz)`,
    );
  }
  if (opts.kinds && opts.kinds.length > 0) {
    baseConditions.push(inArray(attentionItems.kind, opts.kinds));
  }

  const decoded = opts.cursor ? decodeInboxCursor(opts.cursor) : null;
  if (opts.cursor && !decoded) {
    return err(coreError('validation', 'Invalid inbox cursor'));
  }

  const conditions = [...baseConditions];
  if (decoded) {
    conditions.push(
      or(
        lt(attentionItems.score, decoded.s),
        and(
          eq(attentionItems.score, decoded.s),
          lt(attentionItems.createdAt, new Date(decoded.t)),
        ),
        and(
          eq(attentionItems.score, decoded.s),
          eq(attentionItems.createdAt, new Date(decoded.t)),
          lt(attentionItems.id, decoded.i),
        ),
      )!,
    );
  }

  const limit = opts.limit ?? 100;
  const rows = await ctx.db.query.attentionItems.findMany({
    where: and(...conditions),
    orderBy: [
      desc(attentionItems.score),
      desc(attentionItems.createdAt),
      desc(attentionItems.id),
    ],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeInboxCursor({
          score: last.score,
          createdAt: last.createdAt,
          id: last.id,
        })
      : null;

  const itemIds = [...new Set(page.map((r) => r.workItemId))];
  const items =
    itemIds.length === 0
      ? []
      : await ctx.db.query.workItems.findMany({
          where: inArray(workItems.id, itemIds),
        });
  const keyById = new Map(items.map((i) => [i.id, i.key]));

  const roleByProject = new Map<string, Awaited<ReturnType<typeof getProjectRole>>>();
  const mapped = [];
  for (const row of page) {
    let role = roleByProject.get(row.projectId);
    if (role === undefined) {
      role = await getProjectRole(ctx, row.projectId);
      roleByProject.set(row.projectId, role);
    }
    const canAct = canActOnRow(ctx, row.askedOf, role, row.projectId);
    mapped.push(mapRow(row, keyById.get(row.workItemId) ?? '?', canAct));
  }

  const groups: AttentionPage['groups'] = [];
  for (const kind of KIND_ORDER) {
    const itemsInKind = mapped.filter((m) => m.kind === kind);
    if (itemsInKind.length > 0) groups.push({ kind, items: itemsInKind });
  }

  const totalOpen = await ctx.db
    .select({ c: sql<number>`count(*)::int` })
    .from(attentionItems)
    .where(and(...baseConditions));

  return ok({
    groups,
    nextCursor,
    totalOpen: Number(totalOpen[0]?.c ?? 0),
  });
}

function canActOnRow(
  ctx: ServiceContext,
  askedOf: string,
  role: Awaited<ReturnType<typeof getProjectRole>>,
  projectId: string,
): boolean {
  if (!role) return false;
  if (askedOf === 'owner') return role === 'owner';
  if (askedOf === 'maintainer') return role === 'owner' || role === 'maintainer';
  return can(ctx.actor, 'work_item.update', {
    type: 'work_item',
    projectId,
    role,
  });
}

export async function countInbox(
  ctx: ServiceContext,
  opts: { projectIds?: string[] },
): Promise<Result<Record<AttentionKind, number>, CoreError>> {
  const projectsR = await filterProjectIds(ctx, opts.projectIds);
  if (!projectsR.ok) return projectsR;
  const pids = projectsR.value;
  const base: Record<AttentionKind, number> = {
    blocking_question: 0,
    pending_approval: 0,
    budget_block: 0,
    run_failed: 0,
    run_completed_no_report: 0,
    loop_escalation: 0,
    external_block: 0,
  };
  if (pids.length === 0) return ok(base);

  const rows = await ctx.db
    .select({
      kind: attentionItems.kind,
      c: sql<number>`count(*)::int`,
    })
    .from(attentionItems)
    .where(
      and(
        eq(attentionItems.status, 'open'),
        inArray(attentionItems.projectId, pids),
        sql`(${attentionItems.snoozedUntil} is null or ${attentionItems.snoozedUntil} <= now())`,
      ),
    )
    .groupBy(attentionItems.kind);
  for (const r of rows) {
    if (r.kind in base) base[r.kind as AttentionKind] = Number(r.c);
  }
  return ok(base);
}

export async function getInFlightSummary(
  ctx: ServiceContext,
  projectIds?: string[],
): Promise<Result<InFlightSummary, CoreError>> {
  const projectsR = await filterProjectIds(ctx, projectIds);
  if (!projectsR.ok) return projectsR;
  const pids = projectsR.value;
  if (pids.length === 0) {
    return ok({
      itemsInFlight: 0,
      oldestRunMinutes: null,
      activeRunCount: 0,
      lastHumanAttentionAt: null,
    });
  }

  const pidList = sql.join(
    pids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const inFlight = await ctx.db.execute(sql`
    select count(distinct w.id)::int as items
    from work_items w
    join runs r on r.work_item_id = w.id
    where w.project_id in (${pidList})
      and w.archived_at is null
      and r.status in ('pending','launched','running')
  `);
  const oldest = await ctx.db.execute(sql`
    select max(extract(epoch from (now() - r.launched_at))/60)::int as minutes
    from runs r
    join work_items w on w.id = r.work_item_id
    where w.project_id in (${pidList})
      and r.status in ('launched','running')
      and r.launched_at is not null
  `);
  const active = await ctx.db.execute(sql`
    select count(*)::int as c from runs r
    join work_items w on w.id = r.work_item_id
    where w.project_id in (${pidList})
      and r.status in ('pending','launched','running')
  `);
  const lastHuman = await ctx.db.execute(sql`
    select max(resolved_at) as at from attention_items
    where project_id in (${pidList})
      and resolved_at is not null
  `);

  const a = inFlight as unknown as Array<{ items: number }>;
  const b = oldest as unknown as Array<{ minutes: number | null }>;
  const c = active as unknown as Array<{ c: number }>;
  const d = lastHuman as unknown as Array<{ at: Date | null }>;

  return ok({
    itemsInFlight: Number(a[0]?.items ?? 0),
    oldestRunMinutes: b[0]?.minutes != null ? Number(b[0].minutes) : null,
    activeRunCount: Number(c[0]?.c ?? 0),
    lastHumanAttentionAt: d[0]?.at ?? null,
  });
}

export async function getAttentionItem(
  ctx: ServiceContext,
  id: string,
): Promise<Result<ReturnType<typeof mapRow>, CoreError>> {
  const row = await ctx.db.query.attentionItems.findFirst({
    where: eq(attentionItems.id, id),
  });
  if (!row || row.status !== 'open') {
    return err(coreError('not_found', 'Attention item not found'));
  }
  const role = await getProjectRole(ctx, row.projectId);
  if (
    !can(ctx.actor, 'project.read', { type: 'project', projectId: row.projectId, role })
  ) {
    return err(coreError('not_found', 'Attention item not found'));
  }
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, row.workItemId),
  });
  return ok(mapRow(row, item?.key ?? '?', canActOnRow(ctx, row.askedOf, role, row.projectId)));
}
