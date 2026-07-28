import type { CoreError } from '@nexus/core';

export function mapCoreErrorToHttp(error: CoreError): number {
  switch (error.code) {
    case 'validation':
    case 'invalid_transition':
      return 400;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'stale_version':
    case 'conflict':
    case 'gate_blocked':
      return 409;
    default:
      return 422;
  }
}

export function parseApiJsonBody(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export function safeApiErrorResponse(
  requestId: string,
  err: unknown,
): { status: number; detail: string } {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const core = err as CoreError;
    return { status: mapCoreErrorToHttp(core), detail: core.message };
  }
  const message = err instanceof Error ? err.message : '';
  if (message.includes('public_event_projection_failed')) {
    return { status: 500, detail: 'Event delivery preparation failed' };
  }
  return { status: 500, detail: 'An unexpected error occurred' };
}
