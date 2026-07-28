import {
  isAcceptanceCriteriaEnabled,
  isVisualConfirmationEnabled,
  normalizeOptionalConcepts,
  VisualConfirmationConfigSchema,
} from '@nexus/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { artifactRefs, stageInstances } from '@nexus/db';
import type { GateContext } from '../conditions/evaluate';
import type { ServiceContext } from '../context';
import type { GateEvalResult, GateRow } from '../gates/registry';

export {
  isAcceptanceCriteriaEnabled,
  isVisualConfirmationEnabled,
  normalizeOptionalConcepts,
};

/**
 * Visual confirmation gate — requires artifact refs of accepted kinds on the
 * current stage instance. Only meaningful when project optional concept is on.
 */
export async function visualConfirmationGate(input: {
  gate: GateRow;
  ctx: GateContext;
  workItemId: string;
  serviceCtx: ServiceContext;
  optionalConcepts: unknown;
}): Promise<GateEvalResult> {
  const started = Date.now();
  if (!isVisualConfirmationEnabled(input.optionalConcepts)) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'skipped',
      reason: 'visual confirmation concept disabled for project',
      evidence: {},
      durationMs: Date.now() - started,
    };
  }

  const parsed = VisualConfirmationConfigSchema.safeParse(input.gate.config);
  if (!parsed.success) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'error',
      reason: 'Invalid visual_confirmation config',
      evidence: { issues: parsed.error.flatten() },
      durationMs: Date.now() - started,
    };
  }

  const concepts = normalizeOptionalConcepts(input.optionalConcepts);
  const requiredStage = concepts.visualConfirmation.requiredAtStageId;
  if (requiredStage && input.ctx.ticket.stageId !== requiredStage) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'pass',
      reason: 'Not required at this stage',
      evidence: { requiredStage },
      durationMs: Date.now() - started,
    };
  }

  const kinds = parsed.data.evidenceKinds;
  const stageInstanceId = input.ctx.ticket.currentStageInstanceId;
  if (!stageInstanceId) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'block',
      reason: parsed.data.message,
      evidence: { missing: 'stage_instance' },
      durationMs: Date.now() - started,
    };
  }

  // Artifacts attached on runs for this stage instance
  const instance = await input.serviceCtx.db.query.stageInstances.findFirst({
    where: eq(stageInstances.id, stageInstanceId),
  });
  void instance;

  const refs = await input.serviceCtx.db.query.artifactRefs.findMany({
    where: and(
      eq(artifactRefs.workItemId, input.workItemId),
      inArray(artifactRefs.kind, kinds),
    ),
  });

  // Prefer refs from current stage when stageInstanceId is on the ref via run —
  // artifact_refs link to work_item; any matching kind on the item counts for PoC.
  if (refs.length === 0) {
    const outcome = input.gate.onFailure === 'warn' ? 'warn' : 'block';
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome,
      reason: parsed.data.message,
      evidence: { requiredKinds: kinds, found: 0 },
      warningCode:
        outcome === 'warn'
          ? parsed.data.code ?? 'visual.confirmation_missing'
          : undefined,
      durationMs: Date.now() - started,
    };
  }

  return {
    gateId: input.gate.id,
    gateName: input.gate.name,
    gateVersion: input.gate.version,
    outcome: 'pass',
    reason: 'Visual confirmation evidence present',
    evidence: {
      requiredKinds: kinds,
      found: refs.length,
      refs: refs.slice(0, 5).map((r) => ({ id: r.id, kind: r.kind, url: r.url })),
    },
    durationMs: Date.now() - started,
  };
}

/** Completeness: acceptance criteria missing only when concept enabled. */
export function acceptanceCriteriaMissing(input: {
  optionalConcepts: unknown;
  acceptanceCriteriaCount: number;
  requiredAtStageId?: string;
  currentStageId?: string | null;
}): boolean {
  const concepts = normalizeOptionalConcepts(input.optionalConcepts);
  if (!concepts.acceptanceCriteria.enabled) return false;
  const required = concepts.acceptanceCriteria.requiredAtStageId;
  if (required && input.currentStageId && required !== input.currentStageId) {
    return false;
  }
  return input.acceptanceCriteriaCount === 0;
}
