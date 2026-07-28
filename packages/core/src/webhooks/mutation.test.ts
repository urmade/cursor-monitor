import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildSignatureHeader,
  verifyWebhookSignature,
  classifyHttpStatus,
  nextBackoffSec,
} from '../webhooks/signing';
import { apiScopeAllowsAction } from '../api-tokens/scopes';
import { can } from '../authz/can';
import { replayWebhookDelivery } from '../webhooks/deliver';
import { checkRateLimitWindow, resetMemoryRateLimits } from '../redis/rate-limit';

describe('phase 8 mutation probes (apply + observe)', () => {
  const secret = 'whsec_mut';
  const body = '{"a":1}';
  const t = 1_800_000_000;
  const goodHeader = buildSignatureHeader(secret, body, t);

  it('signer: body-only HMAC must not verify (M01 guard)', () => {
    const secret = 'whsec_mut';
    const body = '{"a":1}';
    const t = 1_800_000_000;
    const bodyOnly = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    const header = `t=${t},v1=${bodyOnly}`;
    expect(verifyWebhookSignature(secret, body, header, t).ok).toBe(false);
  });

  it('signer: broken v1 → verify fails', () => {
    const broken = goodHeader.replace(/v1=[a-f0-9]+/, 'v1=00');
    expect(verifyWebhookSignature(secret, body, broken, t).ok).toBe(false);
  });

  it('retry policy: 500 must not be permanent_failure', () => {
    expect(classifyHttpStatus(500)).toBe('retry');
  });

  it('backoff: first step is 60s', () => {
    expect(nextBackoffSec(1)).toBe(60);
  });

  it('scope map: without runs:write, run.launch denied', () => {
    expect(apiScopeAllowsAction(['items:read'], 'run.launch')).toBe(false);
  });

  it('authz: api token without runs:write cannot launch', () => {
    const actor = {
      kind: 'api_token' as const,
      tokenId: '00000000-0000-7000-8000-000000000001',
      projectId: '00000000-0000-7000-8000-000000000002',
      scopes: ['items:read'],
    };
    expect(
      can(actor, 'run.launch', {
        type: 'work_item',
        projectId: actor.projectId,
        role: null,
      }),
    ).toBe(false);
  });

  it('rate limit: 61st request in 1s window blocked', async () => {
    resetMemoryRateLimits();
    const key = `mut-${Date.now()}`;
    let lastAllowed = true;
    for (let i = 0; i < 61; i++) {
      const r = await checkRateLimitWindow(`api:${key}:sec`, 60, 1);
      lastAllowed = r.allowed;
    }
    expect(lastAllowed).toBe(false);
  });

  it('replay: missing delivery returns not ok', async () => {
    const db = {
      query: {
        webhookDeliveries: {
          findFirst: async () => undefined,
        },
      },
    } as never;
    const ctx = {
      db,
      clock: () => new Date(),
    } as never;
    const r = await replayWebhookDelivery(ctx, '00000000-0000-7000-8000-000000000099');
    expect(r.ok).toBe(false);
  });
});
