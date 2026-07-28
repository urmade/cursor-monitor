import type { DerivedStatus, StatusFacts, StatusOverride } from '@nexus/contracts';

export type WorkItemStatusInput = {
  archivedAt: Date | null;
  externallyBlockedReason: string | null;
};

/**
 * Pure derived status. No code path writes a status string onto the work item.
 * Phase 3 completes needs_approval and blocked_by_gate; budget/loop remain later.
 */
export function deriveStatus(
  item: WorkItemStatusInput,
  facts: Partial<StatusFacts> = {},
): DerivedStatus {
  const f: StatusFacts = {
    activeRuns: facts.activeRuns ?? 0,
    openBlockingQuestions: facts.openBlockingQuestions ?? 0,
    failedRunsSinceLastSuccess: facts.failedRunsSinceLastSuccess ?? 0,
    pendingApprovals: facts.pendingApprovals ?? 0,
    blockingGateResults: facts.blockingGateResults ?? 0,
    budgetState: facts.budgetState ?? 'ok',
    loopEscalated: facts.loopEscalated ?? false,
    override: facts.override ?? null,
  };

  if (item.archivedAt) return 'archived';

  if (f.override) {
    return f.override.status;
  }

  if (item.externallyBlockedReason) return 'blocked_external';
  if (f.budgetState === 'blocked') return 'paused_budget';
  if (f.openBlockingQuestions > 0) return 'needs_answer';
  if (f.pendingApprovals > 0) return 'needs_approval';
  if (f.blockingGateResults > 0) return 'blocked_by_gate';
  if (f.failedRunsSinceLastSuccess > 0 && f.activeRuns === 0) return 'failed_run';
  if (f.loopEscalated) return 'needs_approval';
  if (f.activeRuns > 0) return 'ai_working';

  return 'idle';
}

export function overrideFacts(override: StatusOverride | null): Partial<StatusFacts> {
  return { override };
}
