import {
  FieldRuleConfigSchema,
  HumanApprovalConfigSchema,
  unwrapCondition,
  type GateTrigger,
} from '@nexus/contracts';
import { describeCondition } from '../conditions/describe';
import { evaluateCondition } from '../conditions/evaluate';
import {
  registerEvaluator,
  type GateEvalResult,
  type GateRow,
} from './registry';

function fieldRule(input: {
  gate: GateRow;
  ctx: import('../conditions/evaluate').GateContext;
}): GateEvalResult {
  const started = Date.now();
  const parsed = FieldRuleConfigSchema.safeParse(input.gate.config);
  if (!parsed.success) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'error',
      reason: 'Invalid field_rule config',
      evidence: { issues: parsed.error.flatten() },
      durationMs: Date.now() - started,
    };
  }
  const config = parsed.data;
  const requireAst = config.require;
  const requireResult = evaluateCondition(requireAst, input.ctx);

  if (!requireResult.ok) {
    const outcome = input.gate.onFailure === 'warn' ? 'warn' : 'block';
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome,
      reason: config.message || `Failed: ${describeCondition(requireAst)}`,
      evidence: requireResult.evidence,
      warningCode:
        outcome === 'warn'
          ? fieldRuleWarningCode(input.gate)
          : undefined,
      durationMs: Date.now() - started,
    };
  }

  if (config.warnWhen) {
    const warnResult = evaluateCondition(config.warnWhen, input.ctx);
    if (warnResult.ok) {
      return {
        gateId: input.gate.id,
        gateName: input.gate.name,
        gateVersion: input.gate.version,
        outcome: 'warn',
        reason: config.message || `Warn: ${describeCondition(config.warnWhen)}`,
        evidence: warnResult.evidence,
        warningCode: fieldRuleWarningCode(input.gate),
        durationMs: Date.now() - started,
      };
    }
  }

  return {
    gateId: input.gate.id,
    gateName: input.gate.name,
    gateVersion: input.gate.version,
    outcome: 'pass',
    reason: 'Condition satisfied',
    evidence: requireResult.evidence,
    durationMs: Date.now() - started,
  };
}

function humanApproval(input: {
  gate: GateRow;
  ctx: import('../conditions/evaluate').GateContext;
  existingPendingApprovalId?: string | null;
}): GateEvalResult {
  const started = Date.now();
  const parsed = HumanApprovalConfigSchema.safeParse(input.gate.config);
  if (!parsed.success) {
    return {
      gateId: input.gate.id,
      gateName: input.gate.name,
      gateVersion: input.gate.version,
      outcome: 'error',
      reason: 'Invalid human_approval config',
      evidence: { issues: parsed.error.flatten() },
      durationMs: Date.now() - started,
    };
  }

  // Approval decision is async — always block until an approved decision exists.
  // The approvals service marks pending approvals; evaluateGates creates rows.
  return {
    gateId: input.gate.id,
    gateName: input.gate.name,
    gateVersion: input.gate.version,
    outcome: 'block',
    reason: 'awaiting_approval',
    evidence: {
      instructions: parsed.data.instructions,
      approverRoles: parsed.data.approverRoles,
      allowSelfApproval: parsed.data.allowSelfApproval,
    },
    approvalId: input.existingPendingApprovalId ?? undefined,
    durationMs: Date.now() - started,
  };
}

function stubEvaluator(
  kind: 'budget' | 'agentic',
): (input: { gate: GateRow }) => GateEvalResult {
  return (input) => ({
    gateId: input.gate.id,
    gateName: input.gate.name,
    gateVersion: input.gate.version,
    outcome: 'skipped',
    reason: `${kind} evaluator not yet available (Phase ${kind === 'budget' ? '4' : '7'})`,
    evidence: { stub: true },
    durationMs: 0,
  });
}

export function ensureDefaultEvaluatorsRegistered(): void {
  registerEvaluator('field_rule', fieldRule);
  registerEvaluator('human_approval', humanApproval);
  registerEvaluator('budget', stubEvaluator('budget'));
  registerEvaluator('agentic', stubEvaluator('agentic'));
}

function slugCode(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.|\.$/g, '')
      .slice(0, 80) || 'gate.warn'
  );
}

/** Warning code for a field_rule gate: explicit config.code, else slug of gate name. */
export function fieldRuleWarningCode(
  gate: { name: string; config: Record<string, unknown> },
): string {
  return typeof gate.config.code === 'string' && gate.config.code.trim()
    ? gate.config.code.trim()
    : slugCode(gate.name);
}

/** Check whether a gate's trigger matches the evaluation trigger. */
export function triggerMatches(
  gateTrigger: GateTrigger,
  evalTrigger: GateTrigger,
): boolean {
  if (gateTrigger.kind !== evalTrigger.kind) return false;
  switch (gateTrigger.kind) {
    case 'on_transition': {
      if (evalTrigger.kind !== 'on_transition') return false;
      if (gateTrigger.toStageId !== evalTrigger.toStageId) return false;
      if (
        gateTrigger.fromStageId &&
        evalTrigger.fromStageId &&
        gateTrigger.fromStageId !== evalTrigger.fromStageId
      ) {
        return false;
      }
      return true;
    }
    case 'on_run_finished': {
      if (evalTrigger.kind !== 'on_run_finished') return false;
      if (gateTrigger.stageId && evalTrigger.stageId) {
        return gateTrigger.stageId === evalTrigger.stageId;
      }
      return true;
    }
    case 'on_label_added': {
      if (evalTrigger.kind !== 'on_label_added') return false;
      return gateTrigger.labelKey === evalTrigger.labelKey;
    }
    case 'on_demand':
      return evalTrigger.kind === 'on_demand';
    default:
      return false;
  }
}

export function appliesWhenMatches(
  appliesWhen: unknown | null,
  ctx: import('../conditions/evaluate').GateContext,
): boolean {
  if (appliesWhen == null) return true;
  const ast = unwrapCondition(appliesWhen);
  if (!ast) return true;
  return evaluateCondition(ast, ctx).ok;
}
