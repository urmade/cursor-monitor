import { describe, expect, it, beforeEach } from 'vitest';
import { checkRateLimit, resetMemoryRateLimits } from './rate-limit';

describe('checkRateLimit (memory fallback)', () => {
  beforeEach(() => {
    resetMemoryRateLimits();
  });

  it('allows up to the limit then denies', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await checkRateLimit('test:key', 3);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkRateLimit('test:key', 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });
});
