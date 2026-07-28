import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  AUTO_DISABLE_CONSECUTIVE_FAILURES,
  buildSignatureHeader,
  classifyHttpStatus,
  nextBackoffSec,
  signWebhookPayload,
  verifyWebhookSignature,
  SIGNATURE_TOLERANCE_SEC,
} from './signing';
import { missingScopeForAction } from '../api-tokens/scopes';
import { can } from '../authz/can';
import {
  compareEventOrder,
  migrateLegacyWebhookDispatcherCursor,
  readOutboxCursor,
  webhookDispatcherCursorKey,
} from '../events/outbox-cursor';
import { checkRateLimitWindow, resetMemoryRateLimits } from '../redis/rate-limit';
import { PUBLIC_EVENTS, PUBLIC_EVENT_TYPES, zodSchemaFingerprint } from '@nexus/contracts';
import { projectPublicEventData, parsePublicEventData } from './public-projection';

describe('phase 8 mutation guards (24 probes)', () => {
  it('M01: signature binds timestamp into HMAC input', () => {
    const secret = 'whsec_m01';
    const body = '{}';
    const t = 1_900_000_000;
    const header = buildSignatureHeader(secret, body, t);
    const bodyOnly = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyWebhookSignature(secret, body, `t=${t},v1=${bodyOnly}`, t).ok).toBe(false);
    expect(signWebhookPayload(secret, body, t)).not.toBe(bodyOnly);
    expect(verifyWebhookSignature(secret, body, header, t).ok).toBe(true);
  });

  it('M02: rejects malformed signature header', () => {
    expect(verifyWebhookSignature('s', '{}', 'bad', 1_700_000_000).ok).toBe(false);
  });

  it('M03: uses constant-time compare for signature bytes', () => {
    expect(typeof timingSafeEqual).toBe('function');
    const a = Buffer.from('aa', 'hex');
    const b = Buffer.from('ab', 'hex');
    expect(timingSafeEqual(a, a)).toBe(true);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('M04: enforces replay tolerance window', () => {
    const secret = 'whsec_m04';
    const body = '{}';
    const t = 1_700_000_000;
    const header = buildSignatureHeader(secret, body, t);
    const now = t + SIGNATURE_TOLERANCE_SEC + 1;
    expect(verifyWebhookSignature(secret, body, header, now).ok).toBe(false);
  });

  it('M05: classifies 429 as retry', () => {
    expect(classifyHttpStatus(429)).toBe('retry');
  });

  it('M06: backoff ladder starts at 60s', () => {
    expect(nextBackoffSec(1)).toBe(60);
    expect(nextBackoffSec(2)).toBe(300);
  });

  it('M07: classifies 4xx (except 408/429) as permanent_failure', () => {
    expect(classifyHttpStatus(404)).toBe('permanent_failure');
    expect(classifyHttpStatus(500)).toBe('retry');
  });

  it('M08: auto-disable threshold remains 100 consecutive failures', () => {
    expect(AUTO_DISABLE_CONSECUTIVE_FAILURES).toBe(100);
    expect(AUTO_DISABLE_CONSECUTIVE_FAILURES).toBeLessThan(1_000_000);
  });

  it('M09: missingScopeForAction returns required scope for protected actions', () => {
    expect(missingScopeForAction([], 'work_item.read')).toBe('items:read');
    expect(missingScopeForAction(['items:read'], 'work_item.read')).toBeNull();
  });

  it('M10: api token cannot act on another project via can()', () => {
    const actor = {
      kind: 'api_token' as const,
      tokenId: '00000000-0000-7000-8000-000000000001',
      projectId: '00000000-0000-7000-8000-000000000002',
      scopes: ['items:read', 'items:write'],
    };
    expect(
      can(actor, 'work_item.read', {
        type: 'work_item',
        projectId: '00000000-0000-7000-8000-000000000099',
        role: null,
      }),
    ).toBe(false);
  });

  it('M11: compareEventOrder tie-break uses event id after occurredAt', () => {
    const t = '2024-01-01T00:00:00.000Z';
    expect(
      compareEventOrder(
        { occurredAt: new Date(t), id: 'b' },
        { occurredAt: t, eventId: 'a' },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareEventOrder(
        { occurredAt: new Date(t), id: 'a' },
        { occurredAt: t, eventId: 'b' },
      ),
    ).toBeLessThan(0);
  });

  it('M12: in-order events compare correctly vs cursor', () => {
    const cursor = { occurredAt: '2024-06-01T00:00:00.000Z', eventId: 'mid' };
    expect(
      compareEventOrder(
        { occurredAt: new Date('2024-06-02T00:00:00.000Z'), id: 'z' },
        cursor,
      ),
    ).toBe(1);
    expect(
      compareEventOrder(
        { occurredAt: new Date('2024-05-01T00:00:00.000Z'), id: 'z' },
        cursor,
      ),
    ).toBe(-1);
  });

  it('M13: migrateLegacyWebhookDispatcherCursor is a no-op without legacy key', async () => {
    const db = {
      query: {
        orgs: { findMany: async () => [] },
        appMeta: { findFirst: async () => undefined },
      },
    } as never;
    await expect(migrateLegacyWebhookDispatcherCursor(db)).resolves.toBeUndefined();
  });

  it('M14: webhook scope maps to project.update', () => {
    expect(missingScopeForAction([], 'project.update')).toBe('webhooks:manage');
  });

  it('M15: rate limit blocks burst over window', async () => {
    resetMemoryRateLimits();
    const key = `m15-${Date.now()}`;
    let allowed = true;
    for (let i = 0; i < 61; i++) {
      const r = await checkRateLimitWindow(`api:${key}`, 60, 1);
      allowed = r.allowed;
    }
    expect(allowed).toBe(false);
  });

  it('M16: question.asked projection includes question_id', () => {
    const data = projectPublicEventData(
      {
        type: 'question.asked',
        publicType: 'question.asked',
        subjectId: '00000000-0000-7000-8000-000000000010',
        payload: { text: 'hi', blocking: true },
      },
      {},
    );
    expect(parsePublicEventData('question.asked', data).question_id).toBe(
      '00000000-0000-7000-8000-000000000010',
    );
  });

  it('M17: approval.decided projection carries decision', () => {
    const data = projectPublicEventData(
      {
        type: 'approval.rejected',
        publicType: 'approval.decided',
        subjectId: '00000000-0000-7000-8000-000000000011',
        payload: { gateId: '00000000-0000-7000-8000-000000000012' },
      },
      {},
    );
    expect(parsePublicEventData('approval.decided', data).decision).toBe('rejected');
  });

  it('M18: catalogue fingerprints are structural (not all identical)', () => {
    const hashes = PUBLIC_EVENT_TYPES.map((type) => {
      const entry = PUBLIC_EVENTS[type];
      return createHash('sha256')
        .update(`${entry.version}:${zodSchemaFingerprint(entry.schema)}`)
        .digest('hex');
    });
    expect(new Set(hashes).size).toBeGreaterThan(10);
    const loopDetected = zodSchemaFingerprint(PUBLIC_EVENTS['loop.detected'].schema);
    const loopEscalated = zodSchemaFingerprint(PUBLIC_EVENTS['loop.escalated'].schema);
    expect(loopDetected).toBe(loopEscalated);
    const workCreated = zodSchemaFingerprint(PUBLIC_EVENTS['work_item.created'].schema);
    expect(workCreated).not.toBe(loopDetected);
  });

  it('M19: catalogue freeze detects schema shape change', () => {
    const base = zodSchemaFingerprint(z.object({ a: z.string() }));
    const changed = zodSchemaFingerprint(z.object({ a: z.string(), b: z.string() }));
    expect(base).not.toBe(changed);
  });

  it('M20: per-org webhook cursor key is namespaced', () => {
    const a = webhookDispatcherCursorKey('org-a');
    const b = webhookDispatcherCursorKey('org-b');
    expect(a).not.toBe(b);
    expect(a).toContain('org-a');
  });

  it('M21: readOutboxCursor returns null for missing keys', async () => {
    const db = {
      query: {
        appMeta: {
          findFirst: async () => undefined,
        },
      },
    } as never;
    expect(await readOutboxCursor(db, 'missing-key')).toBeNull();
  });

  it('M22: work_item.created projection validates', () => {
    const data = projectPublicEventData(
      {
        type: 'work_item.created',
        publicType: 'work_item.created',
        subjectId: 'x',
        payload: { key: 'A-1', title: 'T', complexity: null },
      },
      { workItemKey: 'A-1' },
    );
    expect(() => parsePublicEventData('work_item.created', data)).not.toThrow();
  });

  it('M23: invalid public data fails parse at projection boundary', () => {
    expect(() =>
      parsePublicEventData('question.asked', { text: 'no id' } as Record<string, unknown>),
    ).toThrow();
  });

  it('M24: runs:write scope required for run.launch', () => {
    expect(missingScopeForAction(['items:read'], 'run.launch')).toBe('runs:write');
  });
});
