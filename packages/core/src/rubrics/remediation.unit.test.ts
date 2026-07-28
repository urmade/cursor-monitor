import { describe, expect, it } from 'vitest';
import { remediationDecision } from './remediation';
import { DEFAULT_REMEDIATION_MAX_ATTEMPTS } from '@nexus/contracts';

describe('remediation attempt cap', () => {
  it('skips without binding', () => {
    expect(remediationDecision({ hasBinding: false, attempts: 0 })).toBe(
      'skip',
    );
  });

  it('launches when under cap', () => {
    expect(remediationDecision({ hasBinding: true, attempts: 0 })).toBe(
      'launch',
    );
    expect(remediationDecision({ hasBinding: true, attempts: 1 })).toBe(
      'launch',
    );
  });

  it('exhausts at default max of 2', () => {
    expect(remediationDecision({ hasBinding: true, attempts: 2 })).toBe(
      'exhausted',
    );
    expect(DEFAULT_REMEDIATION_MAX_ATTEMPTS).toBe(2);
  });

  it('respects custom max', () => {
    expect(
      remediationDecision({ hasBinding: true, attempts: 2, maxAttempts: 3 }),
    ).toBe('launch');
    expect(
      remediationDecision({ hasBinding: true, attempts: 3, maxAttempts: 3 }),
    ).toBe('exhausted');
  });
});
