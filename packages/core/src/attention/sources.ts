import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AttentionKind } from '@nexus/contracts';
import {
  approvals,
  gates,
  questions,
  runs,
  workItems,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import { computeBudgetState } from '../budgets/state';

export type ExpectedAttentionSource = {
  kind: AttentionKind;
  sourceType: string;
  sourceId: string;
  projectId: string;
  workItemId: string;
  workItemKey: string;
  askedOf: 'anyone' | 'maintainer' | 'owner';
  detail: Record<string, unknown>;
  createdAt: Date;
};

export async function listExpectedAttentionSources(
  ctx: ServiceContext,
  projectIds: string[],
): Promise<ExpectedAttentionSource[]> {
  if (projectIds.length === 0) return [];
  const items = await ctx.db.query.workItems.findMany({
    where: and(inArray(workItems.projectId, projectIds), isNull(workItems.archivedAt)),
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const itemIds = items.map((i) => i.id);
  if (itemIds.length === 0) return [];

  const out: ExpectedAttentionSource[] = [];

  const openQuestions = await ctx.db.query.questions.findMany({
    where: and(inArray(questions.workItemId, itemIds), eq(questions.status, 'open')),
  });
  for (const q of openQuestions) {
    if (!q.blocking) continue;
    const item = byId.get(q.workItemId);
    if (!item) continue;
    out.push({
      kind: 'blocking_question',
      sourceType: 'question',
      sourceId: q.id,
      projectId: item.projectId,
      workItemId: item.id,
      workItemKey: item.key,
      askedOf: 'anyone',
      detail: { text: q.text, options: q.options },
      createdAt: q.createdAt,
    });
  }

  const pendingApprovals = await ctx.db.query.approvals.findMany({
    where: and(inArray(approvals.workItemId, itemIds), eq(approvals.status, 'pending')),
  });
  for (const a of pendingApprovals) {
    const item = byId.get(a.workItemId);
    if (!item) continue;
    const gate = a.gateId
      ? await ctx.db.query.gates.findFirst({ where: eq(gates.id, a.gateId) })
      : null;
    const approverRoles = (gate?.config as { approverRoles?: string[] })?.approverRoles ?? [
      'maintainer',
      'owner',
    ];
    const needsOwner = approverRoles.length === 1 && approverRoles[0] === 'owner';
    out.push({
      kind: 'pending_approval',
      sourceType: 'approval',
      sourceId: a.id,
      projectId: item.projectId,
      workItemId: item.id,
      workItemKey: item.key,
      askedOf: needsOwner ? 'owner' : 'maintainer',
      detail: { gateName: gate?.name ?? 'Approval', approvalId: a.id },
      createdAt: a.requestedAt,
    });
  }

  for (const item of items) {
    if (item.pausedReason === 'budget') {
      const state = await computeBudgetState(ctx, item.id);
      out.push({
        kind: 'budget_block',
        sourceType: 'work_item_budget',
        sourceId: item.id,
        projectId: item.projectId,
        workItemId: item.id,
        workItemKey: item.key,
        askedOf: 'maintainer',
        detail: {
          ratio: state?.item.ratio != null ? Math.round(state.item.ratio * 100) : 100,
        },
        createdAt: item.updatedAt,
      });
    }
    if (item.pausedReason === 'external') {
      out.push({
        kind: 'external_block',
        sourceType: 'work_item_external',
        sourceId: item.id,
        projectId: item.projectId,
        workItemId: item.id,
        workItemKey: item.key,
        askedOf: 'anyone',
        detail: {},
        createdAt: item.updatedAt,
      });
    }
    if (item.loopEscalated) {
      out.push({
        kind: 'loop_escalation',
        sourceType: 'work_item_loop',
        sourceId: item.id,
        projectId: item.projectId,
        workItemId: item.id,
        workItemKey: item.key,
        askedOf: 'maintainer',
        detail: { loopCount: item.loopCount },
        createdAt: item.updatedAt,
      });
    }
  }

  const terminalFailed = await ctx.db.query.runs.findMany({
    where: and(
      inArray(runs.workItemId, itemIds),
      inArray(runs.status, ['failed', 'launch_failed', 'abandoned']),
    ),
  });
  const seenFailed = new Set<string>();
  for (const run of terminalFailed) {
    if (seenFailed.has(run.workItemId)) continue;
    const item = byId.get(run.workItemId);
    if (!item) continue;
    if (item.currentRunId && item.currentRunId !== run.id) continue;
    seenFailed.add(run.workItemId);
    out.push({
      kind: 'run_failed',
      sourceType: 'run',
      sourceId: run.id,
      projectId: item.projectId,
      workItemId: item.id,
      workItemKey: item.key,
      askedOf: 'anyone',
      detail: { errorCode: run.errorCode, runId: run.id },
      createdAt: run.terminalAt ?? run.createdAt,
    });
  }

  const noReport = await ctx.db.query.runs.findMany({
    where: and(inArray(runs.workItemId, itemIds), eq(runs.status, 'completed_no_report')),
  });
  const seenNoReport = new Set<string>();
  for (const run of noReport) {
    if (seenNoReport.has(run.workItemId)) continue;
    const item = byId.get(run.workItemId);
    if (!item) continue;
    if (item.currentRunId && item.currentRunId !== run.id) continue;
    seenNoReport.add(run.workItemId);
    out.push({
      kind: 'run_completed_no_report',
      sourceType: 'run',
      sourceId: run.id,
      projectId: item.projectId,
      workItemId: item.id,
      workItemKey: item.key,
      askedOf: 'anyone',
      detail: { runId: run.id },
      createdAt: run.terminalAt ?? run.createdAt,
    });
  }

  return out;
}

export function sourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

export async function listMemberProjectIds(
  ctx: ServiceContext,
  userId: string,
): Promise<string[]> {
  const rows = await ctx.db.execute(sql`
    select project_id from project_members where user_id = ${userId}
  `);
  const arr = rows as unknown as Array<{ project_id: string }>;
  return arr.map((r) => r.project_id);
}
