/**
 * Client-safe monitoring status helpers (no next/headers).
 * v1 agent-level status is almost always `ACTIVE` — that is NOT "running".
 */

export type RunOutcome =
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'running'
  | 'unknown';

export const RUN_OUTCOME_LABELS: Record<RunOutcome, string> = {
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  running: 'Running',
  unknown: 'Unknown',
};

/**
 * Classify a *run* status (FINISHED / RUNNING / ERROR / …).
 * `ACTIVE` (v1 conversation lifecycle) maps to unknown so badges can hide it.
 */
export function classifyRunStatus(status: string | null | undefined): RunOutcome {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'FINISHED':
      return 'finished';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    case 'RUNNING':
    case 'CREATING':
    case 'PENDING':
    case 'QUEUED':
      return 'running';
    case 'ACTIVE':
    default:
      return 'unknown';
  }
}

export function runDidNotFinish(status: string | null | undefined): boolean {
  const outcome = classifyRunStatus(status);
  return outcome === 'failed' || outcome === 'cancelled' || outcome === 'expired';
}
