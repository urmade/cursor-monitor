export type CoreErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'stale_version'
  | 'validation'
  | 'invalid_transition'
  | 'invariant';

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
