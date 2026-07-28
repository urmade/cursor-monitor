import { describe, expect, it } from 'vitest';
import { estimateFromPriceRow } from './prices';
import type { PriceRow } from './prices';

function row(partial: Partial<PriceRow> & Pick<PriceRow, 'model'>): PriceRow {
  return {
    id: '00000000-0000-4000-8000-000000000099',
    model: partial.model,
    inputMicroUsdPer1k: partial.inputMicroUsdPer1k ?? 3000n,
    outputMicroUsdPer1k: partial.outputMicroUsdPer1k ?? 15000n,
    cacheWriteMicroUsdPer1k: partial.cacheWriteMicroUsdPer1k ?? 0n,
    cacheReadMicroUsdPer1k: partial.cacheReadMicroUsdPer1k ?? 0n,
    surchargeBps: partial.surchargeBps ?? 0,
    effectiveFrom: new Date('2025-01-01'),
    note: null,
    createdAt: new Date('2025-01-01'),
  };
}

describe('estimateFromPriceRow', () => {
  it('matches hand calculation for claude-sonnet-class model', () => {
    const r = row({ model: 'claude-sonnet-4' });
    expect(estimateFromPriceRow(r, { input: 1200, output: 400 })).toBe(9600n);
  });

  it('applies surcharge for gpt-4.1 placeholder', () => {
    const r = row({
      model: 'gpt-4.1',
      inputMicroUsdPer1k: 2000n,
      outputMicroUsdPer1k: 8000n,
      surchargeBps: 500,
    });
    expect(estimateFromPriceRow(r, { input: 1000, output: 500 })).toBe(6300n);
  });

  it('returns zero for unknown model row with zero rates', () => {
    const r = row({
      model: 'totally-unknown-xyz',
      inputMicroUsdPer1k: 0n,
      outputMicroUsdPer1k: 0n,
    });
    expect(estimateFromPriceRow(r, { input: 5000, output: 5000 })).toBe(0n);
  });
});
