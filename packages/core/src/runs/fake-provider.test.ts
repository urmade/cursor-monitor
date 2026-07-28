import { describe, expect, it, vi } from 'vitest';
import { CursorApiError } from '@nexus/cursor-client';

/**
 * Pure mapping of provider run status → nexus run status.
 * Mirrors packages/core/src/runs/lifecycle.ts mapProviderStatus.
 */
function mapProviderStatus(status: string): {
  status: string;
  terminal: boolean;
} {
  const s = status.toUpperCase();
  if (s === 'RUNNING' || s === 'CREATING' || s === 'PENDING') {
    return { status: s === 'RUNNING' ? 'running' : 'launched', terminal: false };
  }
  if (s === 'FINISHED' || s === 'COMPLETED' || s === 'SUCCESS') {
    return { status: 'completed', terminal: true };
  }
  if (s === 'FAILED' || s === 'ERROR') {
    return { status: 'failed', terminal: true };
  }
  if (s === 'CANCELLED' || s === 'CANCELED') {
    return { status: 'cancelled', terminal: true };
  }
  if (s === 'EXPIRED') {
    return { status: 'expired', terminal: true };
  }
  return { status: 'running', terminal: false };
}

function closeOutStatus(
  providerStatus: string,
  hasReport: boolean,
): string {
  const mapped = mapProviderStatus(providerStatus);
  let status = mapped.status;
  if (status === 'completed' && !hasReport) {
    status = 'completed_no_report';
  }
  return status;
}

describe('fake provider semantics', () => {
  it('maps FINISHED without report to completed_no_report', () => {
    expect(closeOutStatus('FINISHED', false)).toBe('completed_no_report');
  });

  it('maps FINISHED with report to completed', () => {
    expect(closeOutStatus('FINISHED', true)).toBe('completed');
  });

  it('maps FAILED / CANCELLED / EXPIRED', () => {
    expect(closeOutStatus('FAILED', false)).toBe('failed');
    expect(closeOutStatus('CANCELLED', false)).toBe('cancelled');
    expect(closeOutStatus('EXPIRED', true)).toBe('expired');
  });

  it('treats agent_busy as distinct CursorApiError', () => {
    const err = new CursorApiError({
      message: 'agent_busy',
      status: 409,
      code: 'agent_busy',
    });
    expect(err.code).toBe('agent_busy');
  });

  it('simulates cancel 500 while still RUNNING', async () => {
    const cancel = vi.fn(async () => {
      throw new CursorApiError({
        message: 'internal',
        status: 500,
        code: 'http_error',
      });
    });
    const getRun = vi.fn(async () => ({ id: 'run-1', status: 'RUNNING' }));

    let cancelFailed = false;
    try {
      await cancel();
    } catch {
      cancelFailed = true;
    }
    const still = await getRun();
    expect(cancelFailed).toBe(true);
    expect(still.status).toBe('RUNNING');
  });
});
