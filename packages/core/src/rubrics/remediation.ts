import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_REMEDIATION_MAX_ATTEMPTS } from '@nexus/contracts';
import { gates, workItems } from '@nexus/db';
import type { ServiceContext } from '../context';
import { emit } from '../events/emit';
import { coreError, type CoreError } from '../errors';
import { err, ok, type Result } from '../result';
import type { StoredVerdict } from './evaluate';

/** Pure decision — exported for unit tests (do not re-implement in tests). */
export function remediationDecision(input: {
  hasBinding: boolean;
  attempts: number;
  maxAttempts?: number;
}): 'launch' | 'exhausted' | 'skip' {
  if (!input.hasBinding) return 'skip';
  const max = input.maxAttempts ?? DEFAULT_REMEDIATION_MAX_ATTEMPTS;
  if (input.attempts >= max) return 'exhausted';
  return 'launch';
}

/**
 * Route a Block verdict to a bound Cursor Automation remediation run.
 * Never runs an in-product agent loop — launchRun → Cursor only.
 */

async function raiseRemediationAttention(
  ctx: ServiceContext,
  input: {
    item: typeof workItems.$inferSelect;
    gate: typeof gates.$inferSelect;
    gateEvaluationId: string;
    message: string;
    sourceId: string;
  },
): Promise<void> {
  try {
    const { upsertAttentionFromSource } = await import('../attention/projection');
    await upsertAttentionFromSource(ctx, {
      projectId: input.item.projectId,
      workItemId: input.item.id,
      workItemKey: input.item.key,
      kind: 'loop_escalation',
      sourceType: 'gate_evaluation',
      sourceId: input.sourceId,
      askedOf: 'maintainer',
      createdAt: new Date(),
      detail: {
        gateName: input.gate.name,
        message: input.message,
      },
    });
  } catch {
    // Best-effort
  }
}

export async function routeRemediation(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    gateId: string;
    gateEvaluationId: string;
    verdict: StoredVerdict;
  },
): Promise<
  Result<
    | { action: 'launched'; runId: string; attempt: number }
    | { action: 'exhausted'; attempts: number }
    | { action: 'launch_failed'; attempts: number; error: string }
    | { action: 'skipped'; reason: string },
    CoreError
  >
> {
  const gate = await ctx.db.query.gates.findFirst({
    where: eq(gates.id, input.gateId),
  });
  if (!gate) return err(coreError('not_found', 'Gate not found'));
  if (!gate.remediationBindingId) {
    return ok({ action: 'skipped', reason: 'no_remediation_binding' });
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const maxAttempts =
    gate.remediationMaxAttempts ?? DEFAULT_REMEDIATION_MAX_ATTEMPTS;
  const attempts = item.remediationAttempts ?? 0;

  const decision = remediationDecision({
    hasBinding: true,
    attempts,
    maxAttempts,
  });

  if (decision === 'exhausted') {
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'remediation.exhausted',
      subjectType: 'work_item',
      subjectId: item.id,
      actor: ctx.actor,
      payload: {
        gateId: gate.id,
        gateEvaluationId: input.gateEvaluationId,
        attempts,
        maxAttempts,
        verdictId: input.verdict.id,
      },
    });

    await raiseRemediationAttention(ctx, {
      item,
      gate,
      gateEvaluationId: input.gateEvaluationId,
      sourceId: input.gateEvaluationId,
      message: `Remediation exhausted after ${attempts} attempts; human review required.`,
    });

    return ok({ action: 'exhausted', attempts });
  }

  // Count the attempt before launch so failures still advance the cap.
  await ctx.db
    .update(workItems)
    .set({
      remediationAttempts: sql`${workItems.remediationAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, input.workItemId));
  const attemptNumber = attempts + 1;

  const { launchRun } = await import('../runs/lifecycle');
  const launch = await launchRun(ctx, {
    workItemId: input.workItemId,
    bindingId: gate.remediationBindingId,
    trigger: {
      kind: 'remediation',
      by: {
        gateEvaluationId: input.gateEvaluationId,
        verdictId: input.verdict.id,
        rubricId: input.verdict.rubricId,
        rubricVersion: input.verdict.rubricVersion,
      },
    },
  });

  if (!launch.ok) {
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'remediation.launch_failed',
      subjectType: 'work_item',
      subjectId: item.id,
      actor: ctx.actor,
      payload: {
        workItemId: item.id,
        gateId: gate.id,
        gateEvaluationId: input.gateEvaluationId,
        verdictId: input.verdict.id,
        attempt: attemptNumber,
        error: launch.error.message,
        errorCode: launch.error.code,
      },
    });

    await raiseRemediationAttention(ctx, {
      item,
      gate,
      gateEvaluationId: input.gateEvaluationId,
      sourceId: `${input.gateEvaluationId}:launch_failed:${attemptNumber}`,
      message: `Remediation launch failed (attempt ${attemptNumber}/${maxAttempts}): ${launch.error.message}`,
    });

    return ok({
      action: 'launch_failed',
      attempts: attemptNumber,
      error: launch.error.message,
    });
  }

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'remediation.launched',
    subjectType: 'run',
    subjectId: launch.value.id,
    actor: ctx.actor,
    payload: {
      workItemId: item.id,
      gateId: gate.id,
      gateEvaluationId: input.gateEvaluationId,
      verdictId: input.verdict.id,
      attempt: attemptNumber,
      bindingId: gate.remediationBindingId,
    },
  });

  return ok({
    action: 'launched',
    runId: launch.value.id,
    attempt: attemptNumber,
  });
}

/** Reset remediation attempts when a gate passes after rewrite. */
export async function resetRemediationAttempts(
  ctx: ServiceContext,
  workItemId: string,
): Promise<void> {
  await ctx.db
    .update(workItems)
    .set({ remediationAttempts: 0, updatedAt: new Date() })
    .where(
      and(eq(workItems.id, workItemId), sql`${workItems.remediationAttempts} > 0`),
    );
}
