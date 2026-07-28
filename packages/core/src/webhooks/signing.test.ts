import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSignatureHeader,
  verifyWebhookSignature,
  classifyHttpStatus,
  nextBackoffSec,
  SIGNATURE_TOLERANCE_SEC,
} from './signing';

describe('webhook signing', () => {
  it('verifies valid signature within tolerance', () => {
    const secret = 'whsec_test_secret';
    const body = '{"type":"work_item.created"}';
    const t = 1_700_000_000;
    const header = buildSignatureHeader(secret, body, t);
    const result = verifyWebhookSignature(secret, body, header, t);
    expect(result.ok).toBe(true);
  });

  it('rejects stale timestamp', () => {
    const secret = 'whsec_test';
    const body = '{}';
    const t = 1_700_000_000;
    const header = buildSignatureHeader(secret, body, t);
    const now = t + SIGNATURE_TOLERANCE_SEC + 10;
    const result = verifyWebhookSignature(secret, body, header, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_outside_tolerance');
  });

  it('classifies HTTP status for retry policy', () => {
    expect(classifyHttpStatus(200)).toBe('success');
    expect(classifyHttpStatus(400)).toBe('permanent_failure');
    expect(classifyHttpStatus(429)).toBe('retry');
    expect(classifyHttpStatus(500)).toBe('retry');
  });

  it('uses backoff ladder', () => {
    expect(nextBackoffSec(1)).toBe(60);
    expect(nextBackoffSec(2)).toBe(300);
  });

  it('binds timestamp into signed material (independent HMAC check)', () => {
    const secret = 'whsec_independent';
    const body = '{"hello":"world"}';
    const t = 1_800_000_123;
    const expected = createHmac('sha256', secret)
      .update(`${t}.${body}`, 'utf8')
      .digest('hex');
    const header = buildSignatureHeader(secret, body, t);
    expect(header).toBe(`t=${t},v1=${expected}`);
    expect(verifyWebhookSignature(secret, body, header, t).ok).toBe(true);

    const bodyOnlySig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    const forgedHeader = `t=${t},v1=${bodyOnlySig}`;
    expect(verifyWebhookSignature(secret, body, forgedHeader, t).ok).toBe(false);
  });

  it('rejects replay when timestamp is outside tolerance even if signature matches old t', () => {
    const secret = 'whsec_replay';
    const body = '{}';
    const t = 1_700_000_000;
    const header = buildSignatureHeader(secret, body, t);
    const now = t + SIGNATURE_TOLERANCE_SEC + 1;
    expect(verifyWebhookSignature(secret, body, header, now).ok).toBe(false);
  });
});
