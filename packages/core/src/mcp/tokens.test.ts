import { describe, expect, it } from 'vitest';
import { createHash, timingSafeEqual } from 'node:crypto';
import { hashToken, mintRawToken } from './tokens';

describe('mcp tokens', () => {
  it('hashes stably with sha256', () => {
    const raw = 'test-token-value-please-ignore';
    expect(hashToken(raw)).toBe(
      createHash('sha256').update(raw, 'utf8').digest('hex'),
    );
  });

  it('mints unique tokens with prefix', () => {
    const a = mintRawToken();
    const b = mintRawToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.prefix).toHaveLength(8);
    expect(a.hash).toHaveLength(64);
    expect(hashToken(a.raw)).toBe(a.hash);
  });

  it('supports constant-time compare of hashes', () => {
    const a = Buffer.from(hashToken('x'), 'hex');
    const b = Buffer.from(hashToken('x'), 'hex');
    expect(timingSafeEqual(a, b)).toBe(true);
  });
});
