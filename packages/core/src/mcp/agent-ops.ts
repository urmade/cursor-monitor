import { and, eq, inArray, isNull } from 'drizzle-orm';
import { SpecContentSchema } from '@nexus/contracts';
import { labels, workItemLabels, workItems } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { createSpecVersion, getSpec } from '../specs/create';

export async function updateSpecFromAgent(
  ctx: ServiceContext,
  input: {
    ticketId: string;
    content: unknown;
    mode?: 'merge' | 'replace';
    baseVersion?: number;
    note?: string;
  },
): Promise<Result<{ version: number; id: string }, CoreError>> {
  if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== input.ticketId) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }

  const parsed = SpecContentSchema.safeParse(input.content);
  if (!parsed.success) {
    return err(
      coreError('validation', 'Invalid spec content', {
        issues: parsed.error.flatten(),
      }),
    );
  }

  const current = await getSpec(ctx, input.ticketId);
  if (input.baseVersion !== undefined) {
    if (!current.ok) {
      return err(coreError('stale_version', 'No spec yet but base_version was set'));
    }
    if (current.value.version !== input.baseVersion) {
      return err(
        coreError('stale_version', 'Spec was modified; base_version mismatch', {
          expected: input.baseVersion,
          actual: current.value.version,
        }),
      );
    }
  }

  let content = parsed.data;
  if (input.mode !== 'replace' && current.ok) {
    const prev = current.value.content as Record<string, unknown>;
    content = SpecContentSchema.parse({
      ...prev,
      ...parsed.data,
      // Arrays/objects from input win when provided
      ...(parsed.data.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: parsed.data.acceptanceCriteria }
        : {}),
      ...(parsed.data.openQuestions !== undefined
        ? { openQuestions: parsed.data.openQuestions }
        : {}),
      ...(parsed.data.custom !== undefined
        ? {
            custom: {
              ...((prev.custom as Record<string, unknown>) ?? {}),
              ...parsed.data.custom,
            },
          }
        : {}),
    });
  }

  const created = await createSpecVersion(
    ctx,
    input.ticketId,
    content,
    input.note ?? 'Agent update_spec',
  );
  if (!created.ok) return created;
  return ok({ version: created.value.version, id: created.value.id });
}

/** Agent-scoped label set: validates agent_settable and unknown keys. */
export async function setAgentLabels(
  ctx: ServiceContext,
  ticketId: string,
  change: { add: string[]; remove: string[] },
): Promise<
  Result<{ added: string[]; removed: string[] }, CoreError>
> {
  if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== ticketId) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }
  if (change.add.length + change.remove.length > 20) {
    return err(coreError('validation', 'Max 20 labels per call'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, ticketId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.update', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot set labels'));
  }

  const keys = [...change.add, ...change.remove];
  const projectLabels = keys.length
    ? await ctx.db.query.labels.findMany({
        where: and(
          eq(labels.projectId, item.projectId),
          inArray(labels.key, keys),
        ),
      })
    : [];
  const byKey = new Map(projectLabels.map((l) => [l.key, l]));

  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length) {
    return err(
      coreError('validation', `Unknown label(s): ${unique(unknown).join(', ')}`, {
        labels_unknown: unique(unknown),
      }),
    );
  }
  const notSettable = change.add.filter((k) => !byKey.get(k)?.agentSettable);
  if (notSettable.length) {
    return err(
      coreError(
        'validation',
        `Label(s) not agent-settable: ${notSettable.join(', ')}`,
      ),
    );
  }

  await ctx.db.transaction(async (tx) => {
    for (const key of change.remove) {
      const label = byKey.get(key)!;
      await tx
        .delete(workItemLabels)
        .where(
          and(
            eq(workItemLabels.workItemId, ticketId),
            eq(workItemLabels.labelId, label.id),
          ),
        );
    }
    for (const key of change.add) {
      const label = byKey.get(key)!;
      if (label.archivedAt) continue;
      await tx
        .insert(workItemLabels)
        .values({
          workItemId: ticketId,
          labelId: label.id,
          setByActor: ctx.actor,
        })
        .onConflictDoNothing();
      await emit(tx, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'label.agent_set',
        subjectType: 'work_item',
        subjectId: ticketId,
        actor: ctx.actor,
        payload: { labelKey: key },
      });
    }
    await tx
      .update(workItems)
      .set({ version: item.version + 1, updatedAt: new Date() })
      .where(eq(workItems.id, ticketId));
  });

  // Phase 3: fire on_label_added gates for each newly added label.
  for (const key of change.add) {
    try {
      const { evaluateOnLabelAdded } = await import('../gates/events');
      const result = await evaluateOnLabelAdded(ctx, {
        workItemId: ticketId,
        labelKey: key,
      });
      if (!result.ok) {
        ctx.logger.warn(
          { err: result.error.message, workItemId: ticketId, labelKey: key },
          'gate evaluation on label added failed',
        );
      }
    } catch (e) {
      ctx.logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          workItemId: ticketId,
          labelKey: key,
        },
        'gate evaluation on label added threw',
      );
    }
  }

  return ok({ added: change.add, removed: change.remove });
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

export async function getTicketForAgent(
  ctx: ServiceContext,
  ticketId: string,
): Promise<Result<Record<string, unknown>, CoreError>> {
  if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== ticketId) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, ticketId),
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

  const { stages, projects, labels: labelsTable } = await import('@nexus/db');
  const stage = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, item.currentStageId),
  });
  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  const labelRows = await ctx.db
    .select({
      key: labelsTable.key,
      name: labelsTable.name,
      category: labelsTable.category,
    })
    .from(workItemLabels)
    .innerJoin(labelsTable, eq(labelsTable.id, workItemLabels.labelId))
    .where(eq(workItemLabels.workItemId, ticketId));

  let specMeta: { version: number; updated_at: string } | null = null;
  const spec = await getSpec(ctx, ticketId);
  if (spec.ok) {
    specMeta = {
      version: spec.value.version,
      updated_at: spec.value.createdAt.toISOString(),
    };
  }

  const { deriveWorkItemStatus } = await import('../status/facts');
  const status = await deriveWorkItemStatus(ctx, ticketId);

  const base =
    process.env.DEPLOYMENT_URL ??
    process.env.NEXUS_PUBLIC_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  let warningPayload: Array<{
    id: string;
    code: string;
    message: string;
    status: string;
    created_at: string;
  }> = [];
  try {
    const { listWarnings } = await import('../warnings');
    const w = await listWarnings(ctx, ticketId, { status: 'open' });
    if (w.ok) {
      warningPayload = w.value.map((row) => ({
        id: row.id,
        code: row.code,
        message: row.message,
        status: row.status,
        created_at: row.createdAt.toISOString(),
      }));
    }
  } catch {
    warningPayload = [];
  }

  let budgetPayload: Record<string, unknown> | null = null;
  try {
    const { computeBudgetState } = await import('../budgets/state');
    const st = await computeBudgetState(ctx, ticketId);
    if (st) {
      budgetPayload = {
        budget_micro_usd: st.item.budgetMicro?.toString() ?? null,
        spent_micro_usd: st.item.spentMicro.toString(),
        ratio: st.item.ratio,
        state: st.item.state,
        project_state: st.project.state,
        project_cap_micro_usd: st.project.capMicro?.toString() ?? null,
        project_spent_micro_usd: st.project.spentMicro.toString(),
      };
    }
  } catch {
    budgetPayload = null;
  }

  let loopsPayload: Record<string, unknown> | null = null;
  try {
    const { getLoopSummary } = await import('../loops');
    const summary = await getLoopSummary(ctx, ticketId);
    if (summary.ok) {
      const last = summary.value.edges.at(-1);
      loopsPayload = {
        count: summary.value.count,
        last_reason: last?.reasonCode ?? null,
        escalated: summary.value.escalated,
        rework_cost_micro_usd: summary.value.reworkCostMicroUsd.toString(),
      };
    }
  } catch {
    loopsPayload = {
      count: item.loopCount ?? 0,
      last_reason: null,
      escalated: item.loopEscalated ?? false,
    };
  }

  return ok({
    id: item.id,
    key: item.key,
    title: item.title,
    description: item.description,
    complexity: item.complexity,
    stage: stage
      ? { key: stage.key, name: stage.name, position: stage.position }
      : null,
    labels: labelRows,
    owner_class: item.ownerClass,
    status,
    spec: specMeta,
    warnings: warningPayload,
    budget: budgetPayload,
    loops: loopsPayload,
    links: {
      ui_url: `${base.replace(/\/$/, '')}/projects/${project?.key}/items/${item.key}`,
    },
  });
}

/** Real gate context for agents (Phase 3). Additive to nexus-mcp/1. */
export async function getGateContextForAgent(
  ctx: ServiceContext,
  ticketId: string,
): Promise<Result<Record<string, unknown>, CoreError>> {
  if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== ticketId) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, ticketId),
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

  const { listRecentGateEvaluations, getLatestGateResultsByGate } =
    await import('../gates/evaluate');
  const { listWarnings } = await import('../warnings');
  const { listPendingApprovalsForItem } = await import('../approvals');

  const latestByGate = await getLatestGateResultsByGate(ctx, ticketId);
  const recent = await listRecentGateEvaluations(ctx, ticketId, 10);
  const openWarnings = await listWarnings(ctx, ticketId, { status: 'open' });
  const pending = await listPendingApprovalsForItem(ctx, ticketId);

  return ok({
    gates: [...latestByGate.values()].map((ev) => ({
      gate_id: ev.gateId,
      gate_name: ev.gateName || null,
      gate_version: ev.gateVersion,
      outcome: ev.outcome,
      reason: ev.reason,
      evidence: ev.evidence,
      evaluated_at: ev.createdAt.toISOString(),
    })),
    recent_evaluations: recent.map((ev) => ({
      id: ev.id,
      gate_id: ev.gateId,
      gate_name: ev.gateName || null,
      outcome: ev.outcome,
      reason: ev.reason,
      batch_id: ev.batchId,
      created_at: ev.createdAt.toISOString(),
    })),
    warnings: openWarnings.ok
      ? openWarnings.value.map((w) => ({
          id: w.id,
          code: w.code,
          message: w.message,
          status: w.status,
          created_at: w.createdAt.toISOString(),
        }))
      : [],
    pending_approvals: pending.map((a) => ({
      id: a.id,
      gate_id: a.gateId,
      status: a.status,
      requested_at: a.requestedAt.toISOString(),
      requested_for: a.requestedFor,
    })),
  });
}
