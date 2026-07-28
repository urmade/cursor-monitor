import { AgenticConfigSchema } from '@nexus/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { pendingEvaluations, newId, rubrics } from '@nexus/db';
import type { GateContext } from '../conditions/evaluate';
import type { ServiceContext } from '../context';
import type { GateEvalResult, GateRow } from '../gates/registry';
import { isCircuitOpen } from './circuit';
import { evaluateRubric } from './evaluate';
import { resetRemediationAttempts, routeRemediation } from './remediation';

function slugCode(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.|\.$/g, '')
      .slice(0, 80) || 'rubric.warn'
  );
}

/**
 * Real agentic gate evaluator. Maps rubric verdict → GateEvalResult.
 * Prefer Warn under uncertainty (enforced inside evaluateRubric).
 */
export async function agenticGateEvaluator(input: {
  gate: GateRow;
  ctx: GateContext;
  workItemId: string;
  serviceCtx: ServiceContext;
  preferAsync?: boolean;
}): Promise<GateEvalResult> {
  const started = Date.now();
  const parsed = AgenticConfigSchema.safeParse(input.gate.config);
  if (!parsed.success) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'error',
      reason: 'Invalid agentic config',
      evidence: { issues: parsed.error.flatten() },
      durationMs: Date.now() - started,
    };
  }

  if (await isCircuitOpen(input.gate.projectId)) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'warn',
      reason: 'Agentic gates temporarily unavailable (circuit open)',
      evidence: { code: 'circuit_open' },
      warningCode: 'agentic.circuit_open',
      durationMs: Date.now() - started,
    };
  }

  const rubric = await input.serviceCtx.db.query.rubrics.findFirst({
    where: eq(rubrics.id, parsed.data.rubricId),
  });
  if (!rubric || rubric.archivedAt) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'error',
      reason: 'Rubric not found',
      evidence: { rubricId: parsed.data.rubricId },
      durationMs: Date.now() - started,
    };
  }

  const useAsync = parsed.data.async === true || input.preferAsync === true;

  if (useAsync) {
    const existing = await input.serviceCtx.db.query.pendingEvaluations.findFirst({
      where: and(
        eq(pendingEvaluations.workItemId, input.workItemId),
        eq(pendingEvaluations.gateId, input.gate.id),
        inArray(pendingEvaluations.status, ['pending', 'running']),
      ),
    });
    if (existing) {
      return {
        gateId: input.gate.id,
        gateName: input.gate.name,
        gateVersion: input.gate.version,
        outcome: 'block',
        reason: 'awaiting_evaluation',
        evidence: {
          pendingEvaluationId: existing.id,
          status: existing.status,
          clearsAutomatically: true,
          awaitingEvaluation: true,
        },
        durationMs: Date.now() - started,
      };
    }

    // Create pending row; job handler completes evaluation.
    const pendingId = newId();
    await input.serviceCtx.db.insert(pendingEvaluations).values({
      id: pendingId,
      workItemId: input.workItemId,
      gateId: input.gate.id,
      projectId: input.gate.projectId,
      trigger: { kind: 'on_demand' },
      status: 'pending',
    });

    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'block',
      reason: 'awaiting_evaluation',
      evidence: {
        pendingEvaluationId: pendingId,
        status: 'pending',
        clearsAutomatically: true,
        awaitingEvaluation: true,
      },
      durationMs: Date.now() - started,
    };
  }

  // Sync path with timeout/cache inside evaluateRubric
  const result = await evaluateRubric(input.serviceCtx, {
    rubricId: parsed.data.rubricId,
    workItemId: input.workItemId,
    skipAuthz: true,
  });

  if (!result.ok) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'warn',
      reason: result.error.message,
      evidence: { error: result.error.code },
      warningCode: 'agentic.eval_error',
      durationMs: Date.now() - started,
    };
  }

  const { outcome, verdict, stored, cacheHit, reason } = result.value;
  const warningCode =
    parsed.data.warningCode ??
    `rubric.${slugCode(rubric.name)}`;

  const evidence: Record<string, unknown> = {
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    rubricName: rubric.name,
    verdictId: stored.id,
    model: stored.model,
    tokens: stored.tokens,
    costMicroUsd: stored.costMicroUsd?.toString() ?? null,
    durationMs: stored.durationMs,
    cacheHit,
    confidence: verdict?.confidence ?? Number(stored.confidence ?? 0),
    criteria: verdict?.criteria ?? stored.criteria,
    suggestedRemediation:
      verdict?.suggested_remediation ?? stored.suggestedRemediation,
    errorCode: stored.errorCode,
    reason,
    modelOutcome: result.value.modelOutcome ?? stored.modelOutcome ?? null,
    policyOverride:
      result.value.modelOutcome != null &&
      result.value.modelOutcome !== outcome
        ? {
            from: result.value.modelOutcome,
            to: outcome,
            policy: rubric.uncertaintyPolicy,
          }
        : null,
  };

  if (outcome === 'pass') {
    await resetRemediationAttempts(input.serviceCtx, input.workItemId);
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'pass',
      reason: verdict?.headline ?? stored.headline,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  if (outcome === 'warn') {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'warn',
      reason: verdict?.headline ?? stored.headline ?? reason ?? 'Warn',
      evidence,
      warningCode,
      durationMs: Date.now() - started,
    };
  }

  if (outcome === 'error') {
    // Schema failure → treat as warn (never Block on infrastructure/schema)
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'warn',
      reason: stored.headline || 'Evaluator error',
      evidence,
      warningCode: 'agentic.eval_error',
      durationMs: Date.now() - started,
    };
  }

  // block
  return {
    gateId: input.gate.id,
    gateName: input.gate.name,
    gateVersion: input.gate.version,
    outcome: 'block',
    reason: verdict?.headline ?? stored.headline,
    evidence: {
      ...evidence,
      remediation: true,
      verdictId: stored.id,
    },
    durationMs: Date.now() - started,
  };
}

/** Called after gate evaluation persistence to launch remediation on Block. */
export async function maybeRemediateAfterAgenticBlock(
  serviceCtx: ServiceContext,
  input: {
    workItemId: string;
    gateId: string;
    gateEvaluationId: string;
    result: GateEvalResult;
  },
): Promise<void> {
  if (input.result.outcome !== 'block') return;
  if (input.result.reason === 'awaiting_evaluation') return;
  const verdictId = input.result.evidence?.verdictId;
  if (typeof verdictId !== 'string') return;

  const { getVerdict } = await import('./evaluate');
  const verdict = await getVerdict(serviceCtx, verdictId);
  if (!verdict.ok) return;

  const routed = await routeRemediation(serviceCtx, {
    workItemId: input.workItemId,
    gateId: input.gateId,
    gateEvaluationId: input.gateEvaluationId,
    verdict: verdict.value,
  });
  if (!routed.ok) {
    serviceCtx.logger.warn(
      { error: routed.error.message, gateEvaluationId: input.gateEvaluationId },
      'remediation.route_failed',
    );
  }
}
