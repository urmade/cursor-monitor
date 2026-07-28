export { loadAttentionWeights, kindSeverity } from './weights';
export { computeAttentionScore, describeScore } from './score';
export { titleAndWhy, defaultActions } from './templates';
export {
  listExpectedAttentionSources,
  listMemberProjectIds,
  type ExpectedAttentionSource,
} from './sources';
export {
  upsertAttentionFromSource,
  resolveAttentionBySource,
  resolveAllForWorkItem,
  rescoreOpenItems,
} from './projection';
export { handleAttentionEvent, isAttentionEvent } from './handlers';
export { dispatchAttentionEvents } from './dispatch';
export { reconcileAttention, readLastReconciliation, type ReconciliationSummary } from './reconcile';
export {
  listInbox,
  countInbox,
  getInFlightSummary,
  getAttentionItem,
  type AttentionPage,
} from './list';
export { executeAction, snoozeAttention, type ActionResult } from './actions';
export { resumeAfterQuestion, type ResumeOutcome } from './resume';
export { notifyAttentionItemCreated, flushPendingNotifications, deliverWithRetries } from './notify';
export {
  boardAttentionSummary,
  classifyAttentionLaneFromFacts,
  classifyAttentionLaneFromFacts as classifyAttentionLane,
  type AttentionLane,
} from './board';
