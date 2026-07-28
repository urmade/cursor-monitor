import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SEC = 300;

export function signWebhookPayload(
  secret: string,
  body: string,
  timestampSec: number,
): string {
  const signed = `${timestampSec}.${body}`;
  return createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
}

export function buildSignatureHeader(secret: string, body: string, nowSec?: number): string {
  const t = nowSec ?? Math.floor(Date.now() / 1000);
  const v1 = signWebhookPayload(secret, body, t);
  return `t=${t},v1=${v1}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowSec?: number,
): { ok: true } | { ok: false; reason: string } {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: 'malformed_signature_header' };
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > SIGNATURE_TOLERANCE_SEC) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }
  const expected = signWebhookPayload(secret, body, t);
  const a = Buffer.from(v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

/** Backoff schedule in seconds after each failed attempt (1-based index). */
export const DELIVERY_BACKOFF_SEC = [60, 300, 900, 3600, 21_600, 86_400];

export function nextBackoffSec(attemptsAfterFailure: number): number {
  const idx = Math.min(attemptsAfterFailure - 1, DELIVERY_BACKOFF_SEC.length - 1);
  return DELIVERY_BACKOFF_SEC[Math.max(0, idx)] ?? DELIVERY_BACKOFF_SEC.at(-1)!;
}

export type HttpDeliveryClass =
  | 'success'
  | 'retry'
  | 'permanent_failure';

export function classifyHttpStatus(status: number): HttpDeliveryClass {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'permanent_failure';
  return 'retry';
}

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const AUTO_DISABLE_CONSECUTIVE_FAILURES = 100;
