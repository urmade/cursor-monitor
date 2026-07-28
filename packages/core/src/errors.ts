export type CoreErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'stale_version'
  | 'validation'
  | 'invalid_transition'
  | 'invariant'
  | 'run_already_active'
  | 'no_binding'
  | 'orchestration_disabled'
  | 'provider_busy'
  | 'provider_error'
  | 'item_archived'
  | 'daily_cap_exceeded'
  | 'concurrency_ceiling';

export type CoreError = {
  code: CoreErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export function coreError(
  code: CoreErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CoreError {
  return details ? { code, message, details } : { code, message };
}
