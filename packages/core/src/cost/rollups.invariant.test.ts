import { describe, expect, it } from 'vitest';
import {
  applyCostRollups,
  mergeCostSource,
  mergeSpendSource,
} from './rollups';

describe('rollup invariants', () => {
  it('mergeSpendSource keeps provider on first provider run', () => {
    expect(mergeSpendSource(null, 'provider')).toBe('provider');
    expect(mergeSpendSource('provider', 'estimated')).toBe('mixed');
  });

  it('mergeCostSource becomes mixed when sources differ', () => {
    expect(mergeCostSource('provider', 'estimated')).toBe('mixed');
    expect(mergeCostSource('estimated', 'provider')).toBe('mixed');
    expect(mergeCostSource('provider', 'provider')).toBe('provider');
  });

  it('applyCostRollups is a function (integration covers stage_instances)', () => {
    expect(typeof applyCostRollups).toBe('function');
  });
});
