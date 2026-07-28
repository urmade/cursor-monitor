import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BatchOutcome, GateOutcome, GateTrigger } from '@nexus/contracts';
import {
  approvals,
  gateEvaluations,
  gates,
  newId,
  warnings,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { buildGateContext, snapshotContext, type GateContext } from '../conditions';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import {
  appliesWhenMatches,
  ensureDefaultEvaluatorsRegistered,
  fieldRuleWarningCode,
  triggerMatches,
} from './evaluators';
import { getEvaluator, type GateEvalResult, type GateRow } from './registry';

ensureDefaultEvaluatorsRegistered();

/** Shape stored in approvals.requested_for — trigger plus attempt scoping. */
export type ApprovalRequestedFor = {
  trigger: GateTrigger;
  requesterUserId: string | null;
  stageInstanceId: string | null;
};

export type WarningRef = {
  id: string;
  code: string;
  message: string;
  status: string;
};

export type GateBatchResult = {
  outcome: BatchOutcome;
  results: GateEvalResult[];
  blockedBy: GateEvalResult[];
  warnings: WarningRef[];
  contextSnapshot: Record<string, unknown>;
  batchId: string;
  /** In observe mode, outcome is still computed but callers should not block. */
  observeOnly: boolean;
  evaluationIds: string[];
};

export function worstOutcome(outcomes: GateOutcome[]): BatchOutcome {
  if (outcomes.includes('block') || outcomes.includes('error')) return 'block';
  if (outcomes.includes('warn')) return 'warn';
  return 'pass';
}

function toGateRow(row: typeof gates.$inferSelect): GateRow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    evaluator: row.evaluator,
    trigger: row.trigger as GateTrigger,
    appliesWhen: row.appliesWhen,
    config: row.config as Record<string, unknown>,
    onFailure: row.onFailure,
    enabled: row.enabled,
    version: row.version,
  };
}

function parseRequestedFor(raw: unknown): ApprovalRequestedFor | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  // New shape: { trigger, requesterUserId, stageInstanceId }
  if (obj.trigger && typeof obj.trigger === 'object') {
    return {
      trigger: obj.trigger as GateTrigger,
      requesterUserId:
        typeof obj.requesterUserId === 'string' ? obj.requesterUserId : null,
      stageInstanceId:
        typeof obj.stageInstanceId === 'string' ? obj.stageInstanceId : null,
    };
  }
  // Legacy bare GateTrigger (pre-fix) — treat as trigger only.
  if (typeof obj.kind === 'string') {
    return {
      trigger: obj as unknown as GateTrigger,
      requesterUserId:
        typeof obj.requesterUserId === 'string' ? obj.requesterUserId : null,
      stageInstanceId:
        typeof obj.stageInstanceId === 'string' ? obj.stageInstanceId : null,
    };
  }
  return null;
}

async function persistWarning(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    gateId: string;
    evaluationId: string;
    originStageInstanceId: string | null;
    code: string;
    message: string;
    dryRun: boolean;
  },
): Promise<WarningRef | null> {
  if (input.dryRun) {
    return {
      id: 'dry-run',
      code: input.code,
      message: input.message,
      status: 'open',
    };
  }

  // De-dupe: reuse latest open or dismissed for same (item, gate, code).
  // Recreate only after a resolved (condition cleared) or when none exist.
  const prior = await ctx.db.query.warnings.findFirst({
    where: and(
      eq(warnings.workItemId, input.workItemId),
      eq(warnings.gateId, input.gateId),
      eq(warnings.code, input.code),
    ),
    orderBy: [desc(warnings.createdAt)],
  });
  if (prior && (prior.status === 'open' || prior.status === 'dismissed')) {
    return {
      id: prior.id,
      code: prior.code,
      message: prior.message,
      status: prior.status,
    };
  }

  const id = newId();
  const inserted = await ctx.db
    .insert(warnings)
    .values({
      id,
      workItemId: input.workItemId,
      gateId: input.gateId,
      gateEvaluationId: input.evaluationId,
      originStageInstanceId: input.originStageInstanceId,
      code: input.code,
      message: input.message,
      status: 'open',
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: (
        await ctx.db.query.workItems.findFirst({
          where: eq(workItems.id, input.workItemId),
        })
      )?.projectId ?? null,
      type: 'warning.created',
      subjectType: 'warning',
      subjectId: id,
      actor: ctx.actor,
      payload: { code: input.code, workItemId: input.workItemId },
    });
    return { id, code: input.code, message: input.message, status: 'open' };
  }

  // Race: another writer won the unique index — re-select open row.
  const raced = await ctx.db.query.warnings.findFirst({
    where: and(
      eq(warnings.workItemId, input.workItemId),
      eq(warnings.gateId, input.gateId),
      eq(warnings.code, input.code),
      eq(warnings.status, 'open'),
    ),
  });
  if (raced) {
    return {
      id: raced.id,
      code: raced.code,
      message: raced.message,
      status: raced.status,
    };
  }
  return null;
}

async function resolveWarningsOnPass(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    gateId: string;
    evaluationId: string;
    code: string;
    dryRun: boolean;
  },
): Promise<void> {
  if (input.dryRun) return;
  // Resolve open *and* dismissed for this code so a dismissal only suppresses
  // until the next pass; a later failure can raise a fresh warning (D4/D9).
  const rows = await ctx.db.query.warnings.findMany({
    where: and(
      eq(warnings.workItemId, input.workItemId),
      eq(warnings.gateId, input.gateId),
      eq(warnings.code, input.code),
      inArray(warnings.status, ['open', 'dismissed']),
    ),
  });
  for (const w of rows) {
    await ctx.db
      .update(warnings)
      .set({
        status: 'resolved',
        resolvedByEvaluationId: input.evaluationId,
      })
      .where(eq(warnings.id, w.id));
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: (
        await ctx.db.query.workItems.findFirst({
          where: eq(workItems.id, input.workItemId),
        })
      )?.projectId ?? null,
      type: 'warning.resolved',
      subjectType: 'warning',
      subjectId: w.id,
      actor: ctx.actor,
      payload: {
        code: w.code,
        evaluationId: input.evaluationId,
        previousStatus: w.status,
      },
    });
  }
}

async function ensurePendingApproval(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    gateId: string;
    evaluationId: string;
    trigger: GateTrigger;
    stageInstanceId: string | null;
    dryRun: boolean;
  },
): Promise<string | undefined> {
  const existing = await ctx.db.query.approvals.findFirst({
    where: and(
      eq(approvals.workItemId, input.workItemId),
      eq(approvals.gateId, input.gateId),
      eq(approvals.status, 'pending'),
    ),
  });
  if (existing) return existing.id;
  if (input.dryRun) return undefined;

  const requestedFor: ApprovalRequestedFor = {
    trigger: input.trigger,
    requesterUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
    stageInstanceId: input.stageInstanceId,
  };

  const id = newId();
  const inserted = await ctx.db
    .insert(approvals)
    .values({
      id,
      workItemId: input.workItemId,
      gateId: input.gateId,
      gateEvaluationId: input.evaluationId,
      requestedFor: requestedFor as unknown as Record<string, unknown>,
      status: 'pending',
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    const item = await ctx.db.query.workItems.findFirst({
      where: eq(workItems.id, input.workItemId),
    });
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item?.projectId ?? null,
      type: 'approval.requested',
      subjectType: 'approval',
      subjectId: id,
      actor: ctx.actor,
      payload: { gateId: input.gateId, workItemId: input.workItemId },
    });
    return id;
  }

  const raced = await ctx.db.query.approvals.findFirst({
    where: and(
      eq(approvals.workItemId, input.workItemId),
      eq(approvals.gateId, input.gateId),
      eq(approvals.status, 'pending'),
    ),
  });
  return raced?.id;
}

/**
 * Evaluate all applicable enabled gates for a work item + trigger.
 * Worst outcome wins; every individual result is stored.
 */
export async function evaluateGates(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    trigger: GateTrigger;
    dryRun?: boolean;
  },
): Promise<Result<GateBatchResult, CoreError>> {
  const dryRun = input.dryRun ?? false;
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, input.workItemId), isNull(workItems.archivedAt)),
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

  const flagOn = await ctx.flags.isEnabled('p3.gates', item.projectId);
  if (!flagOn) {
    return ok({
      outcome: 'pass',
      results: [],
      blockedBy: [],
      warnings: [],
      contextSnapshot: {},
      batchId: newId(),
      observeOnly: false,
      evaluationIds: [],
    });
  }

  const gateContext = await buildGateContext(ctx, input.workItemId);
  if (!gateContext) return err(coreError('not_found', 'Work item not found'));
  const contextSnapshot = snapshotContext(gateContext);
  const observeOnly = gateContext.project.enforcementMode === 'observe';

  const projectGates = await ctx.db.query.gates.findMany({
    where: and(
      eq(gates.projectId, item.projectId),
      eq(gates.enabled, true),
      isNull(gates.archivedAt),
    ),
  });

  const applicable = projectGates.filter((g) =>
    triggerMatches(g.trigger as GateTrigger, input.trigger),
  );

  const batchId = newId();
  const results: GateEvalResult[] = [];
  const warningRefs: WarningRef[] = [];
  const evaluationIds: string[] = [];
  const seenGateIds = new Set<string>();

  for (const g of applicable) {
    if (seenGateIds.has(g.id)) continue;
    seenGateIds.add(g.id);

    const row = toGateRow(g);
    if (!appliesWhenMatches(row.appliesWhen, gateContext)) {
      const skipped: GateEvalResult = {
        gateId: g.id,
        gateName: g.name,
        gateVersion: g.version,
        outcome: 'skipped',
        reason: 'appliesWhen evaluated false',
        evidence: {},
        durationMs: 0,
      };
      results.push(skipped);
      if (!dryRun) {
        const eid = await persistEvaluation(ctx, {
          batchId,
          gate: row,
          workItemId: input.workItemId,
          stageInstanceId: item.currentStageInstanceId,
          trigger: input.trigger,
          result: skipped,
          contextSnapshot,
        });
        evaluationIds.push(eid);
      }
      continue;
    }

    // Human approval: pass only if approved for THIS stage-instance attempt.
    let existingPendingApprovalId: string | null = null;
    let alreadyApproved = false;
    if (row.evaluator === 'human_approval') {
      const pending = await ctx.db.query.approvals.findFirst({
        where: and(
          eq(approvals.workItemId, input.workItemId),
          eq(approvals.gateId, g.id),
          eq(approvals.status, 'pending'),
        ),
      });
      existingPendingApprovalId = pending?.id ?? null;

      const recent = await ctx.db.query.approvals.findFirst({
        where: and(
          eq(approvals.workItemId, input.workItemId),
          eq(approvals.gateId, g.id),
          eq(approvals.status, 'approved'),
        ),
        orderBy: [desc(approvals.decidedAt)],
      });
      if (recent?.status === 'approved') {
        const parsed = parseRequestedFor(recent.requestedFor);
        if (
          parsed &&
          parsed.stageInstanceId &&
          parsed.stageInstanceId === item.currentStageInstanceId
        ) {
          alreadyApproved = true;
        }
      }
    }

    if (alreadyApproved) {
      const passed: GateEvalResult = {
        gateId: g.id,
        gateName: g.name,
        gateVersion: g.version,
        outcome: 'pass',
        reason: 'Approved',
        evidence: { approved: true },
        durationMs: 0,
      };
      results.push(passed);
      if (!dryRun) {
        const eid = await persistEvaluation(ctx, {
          batchId,
          gate: row,
          workItemId: input.workItemId,
          stageInstanceId: item.currentStageInstanceId,
          trigger: input.trigger,
          result: passed,
          contextSnapshot,
        });
        evaluationIds.push(eid);
      }
      continue;
    }

    const evaluator = getEvaluator(row.evaluator);
    if (!evaluator) {
      const missing: GateEvalResult = {
        gateId: g.id,
        gateName: g.name,
        gateVersion: g.version,
        outcome: 'error',
        reason: `No evaluator registered for ${row.evaluator}`,
        evidence: {},
        durationMs: 0,
      };
      results.push(missing);
      if (!dryRun) {
        const eid = await persistEvaluation(ctx, {
          batchId,
          gate: row,
          workItemId: input.workItemId,
          stageInstanceId: item.currentStageInstanceId,
          trigger: input.trigger,
          result: missing,
          contextSnapshot,
        });
        evaluationIds.push(eid);
      }
      continue;
    }

    const result = await evaluator({
      gate: row,
      ctx: gateContext,
      trigger: input.trigger,
      existingPendingApprovalId,
    });
    results.push(result);

    let evaluationId = 'dry-run';
    if (!dryRun) {
      evaluationId = await persistEvaluation(ctx, {
        batchId,
        gate: row,
        workItemId: input.workItemId,
        stageInstanceId: item.currentStageInstanceId,
        trigger: input.trigger,
        result,
        contextSnapshot,
      });
      evaluationIds.push(evaluationId);
    }

    if (result.outcome === 'warn' && result.warningCode) {
      const w = await persistWarning(ctx, {
        workItemId: input.workItemId,
        gateId: g.id,
        evaluationId,
        originStageInstanceId: item.currentStageInstanceId,
        code: result.warningCode,
        message: result.reason,
        dryRun,
      });
      if (w) warningRefs.push(w);
    }

    if (result.outcome === 'pass' && row.evaluator === 'field_rule') {
      await resolveWarningsOnPass(ctx, {
        workItemId: input.workItemId,
        gateId: g.id,
        evaluationId,
        code: fieldRuleWarningCode(row),
        dryRun,
      });
    }

    if (
      result.outcome === 'block' &&
      result.reason === 'awaiting_approval' &&
      row.evaluator === 'human_approval'
    ) {
      const approvalId = await ensurePendingApproval(ctx, {
        workItemId: input.workItemId,
        gateId: g.id,
        evaluationId,
        trigger: input.trigger,
        stageInstanceId: item.currentStageInstanceId,
        dryRun,
      });
      if (approvalId) result.approvalId = approvalId;
    }
  }

  const outcome = worstOutcome(results.map((r) => r.outcome));
  const blockedBy = results.filter((r) => r.outcome === 'block' || r.outcome === 'error');

  if (!dryRun) {
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'gate.evaluated',
      subjectType: 'work_item',
      subjectId: input.workItemId,
      actor: ctx.actor,
      payload: {
        batchId,
        outcome,
        trigger: input.trigger,
        gateCount: results.length,
        observeOnly,
        results: results.map((r) => ({
          gateId: r.gateId,
          gateName: r.gateName,
          outcome: r.outcome,
          reason: r.reason,
          evidence: r.evidence,
        })),
      },
    });
    if (outcome === 'block' && !observeOnly) {
      await emit(ctx.db, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'gate.blocked',
        subjectType: 'work_item',
        subjectId: input.workItemId,
        actor: ctx.actor,
        payload: {
          batchId,
          blockedBy: blockedBy.map((b) => ({
            gateId: b.gateId,
            gateName: b.gateName,
            reason: b.reason,
            evidence: b.evidence,
          })),
        },
      });
    }
    if (outcome === 'warn') {
      await emit(ctx.db, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'gate.warned',
        subjectType: 'work_item',
        subjectId: input.workItemId,
        actor: ctx.actor,
        payload: { batchId, warnings: warningRefs },
      });
    }
  }

  return ok({
    outcome,
    results,
    blockedBy,
    warnings: warningRefs,
    contextSnapshot,
    batchId,
    observeOnly,
    evaluationIds,
  });
}

async function persistEvaluation(
  ctx: ServiceContext,
  input: {
    batchId: string;
    gate: GateRow;
    workItemId: string;
    stageInstanceId: string | null;
    trigger: GateTrigger;
    result: GateEvalResult;
    contextSnapshot: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId();
  await ctx.db.insert(gateEvaluations).values({
    id,
    gateId: input.gate.id,
    gateVersion: input.gate.version,
    gateName: input.gate.name,
    gateConfig: input.gate.config,
    workItemId: input.workItemId,
    stageInstanceId: input.stageInstanceId,
    trigger: input.trigger as unknown as Record<string, unknown>,
    outcome: input.result.outcome,
    reason: input.result.reason,
    evidence: input.result.evidence,
    contextSnapshot: input.contextSnapshot,
    evaluatorMeta: { durationMs: input.result.durationMs },
    batchId: input.batchId,
  });
  return id;
}

/** Preview what a (possibly unsaved) gate would do to a set of work items. */
export async function previewGate(
  ctx: ServiceContext,
  input: {
    projectId: string;
    gate: PreviewGateInput;
    workItemIds: string[];
  },
): Promise<
  Result<
    Array<{
      workItemId: string;
      outcome: GateOutcome;
      reason: string;
      evidence: Record<string, unknown>;
    }>,
    CoreError
  >
> {
  const batch = await previewGates(ctx, {
    projectId: input.projectId,
    gates: [{ id: 'preview', ...input.gate }],
    workItemIds: input.workItemIds,
  });
  if (!batch.ok) return batch;
  return ok(batch.value['preview'] ?? []);
}

export type PreviewGateInput = {
  evaluator: GateRow['evaluator'];
  trigger: GateTrigger;
  appliesWhen?: unknown | null;
  config: Record<string, unknown>;
  onFailure: 'block' | 'warn';
  name?: string;
};

/**
 * Preview many gates against many items, building each item's context exactly once.
 */
export async function previewGates(
  ctx: ServiceContext,
  input: {
    projectId: string;
    gates: Array<PreviewGateInput & { id: string }>;
    workItemIds: string[];
  },
): Promise<
  Result<
    Record<
      string,
      Array<{
        workItemId: string;
        outcome: GateOutcome;
        reason: string;
        evidence: Record<string, unknown>;
      }>
    >,
    CoreError
  >
> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }

  if (input.workItemIds.length > 0) {
    const items = await ctx.db.query.workItems.findMany({
      where: and(
        inArray(workItems.id, input.workItemIds),
        isNull(workItems.archivedAt),
      ),
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of input.workItemIds) {
      const item = byId.get(id);
      if (!item || item.projectId !== input.projectId) {
        return err(
          coreError('validation', 'Work item does not belong to this project', {
            workItemId: id,
          }),
        );
      }
    }
  }

  const { getEvaluator: getEv } = await import('./registry');
  const contexts = new Map<string, GateContext>();
  for (const workItemId of input.workItemIds) {
    const gateContext = await buildGateContext(ctx, workItemId);
    if (gateContext) contexts.set(workItemId, gateContext);
  }

  const out: Record<
    string,
    Array<{
      workItemId: string;
      outcome: GateOutcome;
      reason: string;
      evidence: Record<string, unknown>;
    }>
  > = {};

  for (const gate of input.gates) {
    const rows: Array<{
      workItemId: string;
      outcome: GateOutcome;
      reason: string;
      evidence: Record<string, unknown>;
    }> = [];
    for (const workItemId of input.workItemIds) {
      const gateContext = contexts.get(workItemId);
      if (!gateContext) {
        rows.push({
          workItemId,
          outcome: 'error',
          reason: 'Work item not found',
          evidence: {},
        });
        continue;
      }
      if (!appliesWhenMatches(gate.appliesWhen ?? null, gateContext)) {
        rows.push({
          workItemId,
          outcome: 'skipped',
          reason: 'appliesWhen false',
          evidence: {},
        });
        continue;
      }
      const fake: GateRow = {
        id: gate.id,
        projectId: gateContext.project.id,
        name: gate.name ?? 'preview',
        description: '',
        evaluator: gate.evaluator,
        trigger: gate.trigger,
        appliesWhen: gate.appliesWhen ?? null,
        config: gate.config,
        onFailure: gate.onFailure,
        enabled: true,
        version: 0,
      };
      const ev = getEv(fake.evaluator);
      if (!ev) {
        rows.push({
          workItemId,
          outcome: 'skipped',
          reason: 'evaluator unavailable',
          evidence: {},
        });
        continue;
      }
      const result = await ev({
        gate: fake,
        ctx: gateContext,
        trigger: gate.trigger,
      });
      rows.push({
        workItemId,
        outcome: result.outcome,
        reason: result.reason,
        evidence: result.evidence,
      });
    }
    out[gate.id] = rows;
  }
  return ok(out);
}

export async function listRecentGateEvaluations(
  ctx: ServiceContext,
  workItemId: string,
  limit = 20,
) {
  return ctx.db.query.gateEvaluations.findMany({
    where: eq(gateEvaluations.workItemId, workItemId),
    orderBy: [desc(gateEvaluations.createdAt)],
    limit,
  });
}

/**
 * Latest evaluation per gate for a work item, selecting only chip/panel columns
 * (no context_snapshot jsonb).
 */
export async function getLatestGateResultsByGate(
  ctx: ServiceContext,
  workItemId: string,
): Promise<
  Map<
    string,
    {
      gateId: string;
      gateName: string;
      gateVersion: number;
      gateConfig: Record<string, unknown>;
      outcome: string;
      reason: string;
      evidence: Record<string, unknown>;
      createdAt: Date;
    }
  >
> {
  const rows = await ctx.db
    .select({
      gateId: gateEvaluations.gateId,
      gateName: gateEvaluations.gateName,
      gateVersion: gateEvaluations.gateVersion,
      gateConfig: gateEvaluations.gateConfig,
      outcome: gateEvaluations.outcome,
      reason: gateEvaluations.reason,
      evidence: gateEvaluations.evidence,
      createdAt: gateEvaluations.createdAt,
    })
    .from(gateEvaluations)
    .where(eq(gateEvaluations.workItemId, workItemId))
    .orderBy(desc(gateEvaluations.createdAt))
    .limit(100);

  const map = new Map<
    string,
    {
      gateId: string;
      gateName: string;
      gateVersion: number;
      gateConfig: Record<string, unknown>;
      outcome: string;
      reason: string;
      evidence: Record<string, unknown>;
      createdAt: Date;
    }
  >();
  for (const r of rows) {
    if (!map.has(r.gateId)) {
      map.set(r.gateId, {
        gateId: r.gateId,
        gateName: r.gateName,
        gateVersion: r.gateVersion,
        gateConfig: r.gateConfig,
        outcome: r.outcome,
        reason: r.reason,
        evidence: r.evidence ?? {},
        createdAt: r.createdAt,
      });
    }
  }
  return map;
}

/** Batch chip helper: latest blocking reason per work item (no full snapshots). */
export async function getLatestBlockingReasonsForItems(
  ctx: ServiceContext,
  workItemIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (workItemIds.length === 0) return map;

  // DISTINCT ON guarantees one latest blocking row per item — no shared row cap.
  const { sql } = await import('drizzle-orm');
  const rows = await ctx.db.execute(sql`
    select distinct on (work_item_id)
      work_item_id,
      coalesce(nullif(gate_name, ''), 'gate') as gate_name,
      reason
    from gate_evaluations
    where work_item_id in (${sql.join(
      workItemIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      and outcome in ('block', 'error')
    order by work_item_id, created_at desc
  `);

  for (const r of rows as unknown as Array<{
    work_item_id: string;
    gate_name: string;
    reason: string;
  }>) {
    map.set(r.work_item_id, `${r.gate_name}: ${r.reason}`);
  }
  return map;
}

export type { GateContext };
export { parseRequestedFor };
