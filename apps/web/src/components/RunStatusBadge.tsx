import { Badge, type BadgeTone } from '@nexus/ui';
import {
  classifyRunStatus,
  RUN_OUTCOME_LABELS,
  type RunOutcome,
} from '../lib/monitoring-status';

const OUTCOME_TONES: Record<RunOutcome, BadgeTone> = {
  finished: 'success',
  failed: 'danger',
  cancelled: 'warning',
  expired: 'warning',
  running: 'info',
  unknown: 'neutral',
};

function OutcomeIcon({ outcome }: { outcome: RunOutcome }) {
  const cls = 'size-2.5 shrink-0';
  switch (outcome) {
    case 'finished':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden>
          <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'failed':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" className={cls} aria-hidden>
          <circle cx="8" cy="8" r="5.75" />
          <path d="M5 11l6-6" strokeLinecap="round" />
        </svg>
      );
    case 'expired':
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" className={cls} aria-hidden>
          <circle cx="8" cy="8" r="5.75" />
          <path d="M8 5v3.25l2.25 1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'running':
      return (
        <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />
      );
    default:
      return null;
  }
}

export type RunStatusBadgeProps = {
  status: string | null | undefined;
  /**
   * When false (default), hide the badge unless the run is actively running
   * or ended without finishing. Idle/finished/unknown conversations show
   * nothing — v1 agent status is `ACTIVE` even when no run is in progress.
   */
  showIdle?: boolean;
};

/**
 * Status pill for a conversation or run. Runs that ended without completing
 * (failed / cancelled / expired) get a warning-or-danger tone plus an icon so
 * they stand out in tables.
 */
export function RunStatusBadge({
  status,
  showIdle = false,
}: RunStatusBadgeProps) {
  const outcome = classifyRunStatus(status);
  if (
    !showIdle &&
    outcome !== 'running' &&
    outcome !== 'failed' &&
    outcome !== 'cancelled' &&
    outcome !== 'expired'
  ) {
    return null;
  }
  const label =
    outcome === 'unknown' && status?.trim()
      ? status.trim().toLowerCase().replace(/_/g, ' ')
      : RUN_OUTCOME_LABELS[outcome];
  return (
    <Badge tone={OUTCOME_TONES[outcome]} className="normal-case tracking-normal">
      <OutcomeIcon outcome={outcome} />
      {label}
    </Badge>
  );
}
