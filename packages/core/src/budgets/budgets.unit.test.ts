import { describe, expect, it } from 'vitest';
import { parseProjectBudgetSettings, DEFAULT_BUDGET_SETTINGS } from './settings';
import { levelFromRatio } from './state';

describe('budget settings', () => {
  it('parses defaults when budget object missing', () => {
    const s = parseProjectBudgetSettings({});
    expect(s.burnCapMicroUsd).toBe(DEFAULT_BUDGET_SETTINGS.burnCapMicroUsd);
    expect(s.complexityDefaults.high.hardMicroUsd).toBe(
      DEFAULT_BUDGET_SETTINGS.complexityDefaults.high.hardMicroUsd,
    );
  });

  it('falls back to defaults on malformed budget json', () => {
    const s = parseProjectBudgetSettings({
      budget: { burnCapMicroUsd: 'not-a-number' },
    });
    expect(s.burnCapMicroUsd).toBe(DEFAULT_BUDGET_SETTINGS.burnCapMicroUsd);
  });

  it('detects soft/hard boundary', () => {
    expect(levelFromRatio(0.79, 0.8, 1)).toBe('ok');
    expect(levelFromRatio(0.8, 0.8, 1)).toBe('warn');
    expect(levelFromRatio(1, 0.8, 1)).toBe('blocked');
  });
});
