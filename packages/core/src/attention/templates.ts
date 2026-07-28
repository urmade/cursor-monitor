import type { AttentionKind } from '@nexus/contracts';
import type { AttentionAction } from '@nexus/contracts';

export function titleAndWhy(input: {
  kind: AttentionKind;
  workItemKey: string;
  detail: Record<string, unknown>;
}): { title: string; why: string } {
  const key = input.workItemKey;
  switch (input.kind) {
    case 'blocking_question':
      return {
        title: `Answer: ${String(input.detail.text ?? 'blocking question').slice(0, 120)}`,
        why: `${key}: scoping run stopped and asked a blocking question.`,
      };
    case 'pending_approval':
      return {
        title: `Approve: ${String(input.detail.gateName ?? 'gate')}`,
        why: `${key}: transition is held until a maintainer approves.`,
      };
    case 'budget_block':
      return {
        title: `Budget blocked at ${String(input.detail.ratio ?? '100')}% of item cap`,
        why: `${key}: run refused — item budget exhausted.`,
      };
    case 'run_failed':
      return {
        title: `Run failed: ${String(input.detail.errorCode ?? 'error')}`,
        why: `${key}: agent run ended in failure and may need a retry.`,
      };
    case 'run_completed_no_report':
      return {
        title: 'Run finished without stage report',
        why: `${key}: agent completed but never posted a stage report.`,
      };
    case 'loop_escalation':
      return {
        title: 'Loop escalation — rework threshold exceeded',
        why: `${key}: item returned too many times; needs a human decision.`,
      };
    case 'external_block':
      return {
        title: 'Blocked by external dependency',
        why: `${key}: work is paused waiting on something outside Nexus.`,
      };
    default:
      return { title: `${key}: needs attention`, why: `${key}: requires a human decision.` };
  }
}

export function defaultActions(kind: AttentionKind): AttentionAction[] {
  const openTicket = {
    id: 'open_ticket',
    label: 'Open ticket',
    kind: 'open_ticket',
    requiresConfirm: false,
  };
  switch (kind) {
    case 'blocking_question':
      return [
        { id: 'answer', label: 'Answer…', kind: 'answer', requiresConfirm: false },
        { id: 'withdraw', label: 'Withdraw', kind: 'withdraw', requiresConfirm: false },
        openTicket,
      ];
    case 'pending_approval':
      return [
        { id: 'approve', label: 'Approve', kind: 'approve', requiresConfirm: false },
        { id: 'reject', label: 'Reject', kind: 'reject', requiresConfirm: false },
        openTicket,
      ];
    case 'budget_block':
      return [
        {
          id: 'raise_item',
          label: 'Raise item budget',
          kind: 'raise_item_budget',
          requiresConfirm: false,
        },
        {
          id: 'raise_project',
          label: 'Raise project cap',
          kind: 'raise_project_cap',
          requiresConfirm: true,
        },
        { id: 'pause', label: 'Pause deliberately', kind: 'pause_item', requiresConfirm: false },
        openTicket,
      ];
    case 'run_failed':
      return [
        { id: 'retry', label: 'Retry stage', kind: 'retry_run', requiresConfirm: false },
        { id: 'return', label: 'Return to prior stage', kind: 'loop_return', requiresConfirm: false },
        { id: 'open_cursor', label: 'Open Cursor run', kind: 'open_cursor', requiresConfirm: false },
        openTicket,
      ];
    case 'run_completed_no_report':
      return [
        { id: 'retry', label: 'Retry', kind: 'retry_run', requiresConfirm: false },
        {
          id: 'accept_manual',
          label: 'Accept manually',
          kind: 'accept_no_report',
          requiresConfirm: true,
        },
        openTicket,
      ];
    case 'loop_escalation':
      return [
        { id: 'return', label: 'Return with reason', kind: 'loop_return', requiresConfirm: false },
        { id: 'complexity', label: 'Change complexity', kind: 'change_complexity', requiresConfirm: false },
        { id: 'raise_budget', label: 'Raise budget', kind: 'raise_item_budget', requiresConfirm: false },
        openTicket,
      ];
    case 'external_block':
      return [
        { id: 'clear', label: 'Clear block', kind: 'clear_external', requiresConfirm: false },
        openTicket,
      ];
    default:
      return [openTicket];
  }
}
