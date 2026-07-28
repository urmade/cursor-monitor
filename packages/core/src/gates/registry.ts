import type {
  GateEvaluatorKind,
  GateOutcome,
  GateTrigger,
} from '@nexus/contracts';
import type { GateContext } from '../conditions/evaluate';

export type GateRow = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  evaluator: GateEvaluatorKind;
  trigger: GateTrigger;
  appliesWhen: unknown | null;
  config: Record<string, unknown>;
  onFailure: 'block' | 'warn';
  enabled: boolean;
  version: number;
};

export type GateEvalResult = {
  gateId: string;
  gateName: string;
  gateVersion: number;
  /** Evaluator kind that produced this result (for transition-side filtering). */
  evaluator?: GateEvaluatorKind;
  outcome: GateOutcome;
  reason: string;
  evidence: Record<string, unknown>;
  /** Warning code when outcome is warn. */
  warningCode?: string;
  /** Set when human_approval creates/reuses a pending approval. */
  approvalId?: string;
  durationMs: number;
};

export type EvaluatorFn = (input: {
  gate: GateRow;
  ctx: GateContext;
  trigger: GateTrigger;
  /** Pending approval id if one already exists for this gate+item. */
  existingPendingApprovalId?: string | null;
}) => Promise<GateEvalResult> | GateEvalResult;

const registry = new Map<GateEvaluatorKind, EvaluatorFn>();

export function registerEvaluator(kind: GateEvaluatorKind, fn: EvaluatorFn): void {
  registry.set(kind, fn);
}

export function getEvaluator(kind: GateEvaluatorKind): EvaluatorFn | undefined {
  return registry.get(kind);
}

export function listRegisteredEvaluators(): GateEvaluatorKind[] {
  return [...registry.keys()];
}
