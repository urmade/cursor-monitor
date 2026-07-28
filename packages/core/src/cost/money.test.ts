import { describe, expect, it } from 'vitest';
import {
  applySurchargeBps,
  fromCents,
  fromUsd,
  MICRO_PER_USD,
  toDisplay,
  tokenBucketMicro,
} from './money';

describe('money', () => {
  it('converts cents to micro-USD', () => {
    expect(fromCents(1)).toBe(10_000n);
    expect(fromCents(1.24)).toBe(12_400n);
    expect(fromCents(0.003)).toBe(30n);
  });

  it('formats sub-cent spend', () => {
    expect(toDisplay(500n)).toBe('<$0.01');
    expect(toDisplay(0n)).toBe('$0.00');
    expect(toDisplay(1_240_000n)).toBe('$1.24');
  });

  it('token bucket rounds half-up per bucket', () => {
    const rate = 3000n; // $3 / MTok input
    expect(tokenBucketMicro(500, rate)).toBe(1500n);
    expect(tokenBucketMicro(1, rate)).toBe(3n);
  });

  it('applies surcharge bps', () => {
    const base = 1_000_000n;
    expect(applySurchargeBps(base, 500)).toBe(1_050_000n);
  });

  it('fromUsd matches micro constant', () => {
    expect(fromUsd(10)).toBe(10n * MICRO_PER_USD);
  });
});
