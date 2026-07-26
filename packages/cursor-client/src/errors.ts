export type CursorErrorCode =
  | 'agent_busy'
  | 'agent_id_conflict'
  | 'stream_expired'
  | 'run_not_cancellable'
  | 'http_error'
  | 'network_error'
  | 'rate_limited';

export class CursorApiError extends Error {
  readonly status: number;
  readonly code: CursorErrorCode;
  readonly body: unknown;

  constructor(opts: {
    message: string;
    status: number;
    code: CursorErrorCode;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = 'CursorApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

export function mapHttpError(status: number, body: unknown): CursorApiError {
  const message =
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof (body as { message: unknown }).message === 'string'
      ? (body as { message: string }).message
      : `Cursor API HTTP ${status}`;

  const errorField =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : typeof body === 'object' &&
          body !== null &&
          'code' in body &&
          typeof (body as { code: unknown }).code === 'string'
        ? (body as { code: string }).code
        : '';

  const haystack = `${message} ${errorField}`.toLowerCase();

  if (status === 409 && haystack.includes('agent_busy')) {
    return new CursorApiError({ message, status, code: 'agent_busy', body });
  }
  if (status === 409 && haystack.includes('agent_id_conflict')) {
    return new CursorApiError({
      message,
      status,
      code: 'agent_id_conflict',
      body,
    });
  }
  if (status === 409 && haystack.includes('run_not_cancellable')) {
    return new CursorApiError({
      message,
      status,
      code: 'run_not_cancellable',
      body,
    });
  }
  if (status === 410 || haystack.includes('stream_expired')) {
    return new CursorApiError({
      message,
      status,
      code: 'stream_expired',
      body,
    });
  }
  if (status === 429) {
    return new CursorApiError({
      message,
      status,
      code: 'rate_limited',
      body,
    });
  }
  return new CursorApiError({ message, status, code: 'http_error', body });
}
