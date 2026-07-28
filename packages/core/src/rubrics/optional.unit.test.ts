import { describe, expect, it, beforeEach } from 'vitest';
import {
  getCircuitState,
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuits,
} from './circuit';
import { RUBRIC_CIRCUIT_FAILURES } from '@nexus/contracts';
import {
  acceptanceCriteriaMissing,
  isAcceptanceCriteriaEnabled,
  isVisualConfirmationEnabled,
  normalizeOptionalConcepts,
} from './optional-concepts';

describe('optional concepts', () => {
  it('normalizes boolean legacy form', () => {
    const n = normalizeOptionalConcepts({
      acceptanceCriteria: true,
      visualConfirmation: false,
    });
    expect(n.acceptanceCriteria.enabled).toBe(true);
    expect(n.visualConfirmation.enabled).toBe(false);
    expect(n.visualConfirmation.evidenceKinds).toEqual(['preview', 'artifact']);
  });

  it('normalizes structured form', () => {
    const n = normalizeOptionalConcepts({
      acceptanceCriteria: { enabled: true, requiredAtStageId: undefined },
      visualConfirmation: {
        enabled: true,
        evidenceKinds: ['preview'],
      },
    });
    expect(n.acceptanceCriteria.enabled).toBe(true);
    expect(n.visualConfirmation.evidenceKinds).toEqual(['preview']);
  });

  it('defaults off when missing', () => {
    expect(isAcceptanceCriteriaEnabled({})).toBe(false);
    expect(isVisualConfirmationEnabled(null)).toBe(false);
  });

  it('acceptanceCriteriaMissing is false when concept off', () => {
    expect(
      acceptanceCriteriaMissing({
        optionalConcepts: { acceptanceCriteria: false },
        acceptanceCriteriaCount: 0,
      }),
    ).toBe(false);
  });

  it('acceptanceCriteriaMissing is true when enabled and empty', () => {
    expect(
      acceptanceCriteriaMissing({
        optionalConcepts: { acceptanceCriteria: true },
        acceptanceCriteriaCount: 0,
      }),
    ).toBe(true);
  });
});

describe('fixture provider', () => {
  it('throws when the response queue is empty (never silent Pass)', async () => {
    const { createFixtureProvider } = await import('./provider');
    const p = createFixtureProvider([]);
    await expect(
      p.complete({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 10,
        temperature: 0,
      }),
    ).rejects.toThrow(/queue empty/);
  });
});

describe('circuit breaker', () => {
  beforeEach(async () => {
    await resetCircuits();
  });

  it('opens after N consecutive failures and fails open (warn path)', async () => {
    const projectId = 'proj-circuit-1';
    for (let i = 0; i < RUBRIC_CIRCUIT_FAILURES - 1; i += 1) {
      const r = await recordCircuitFailure(projectId, 1_000);
      expect(r.opened).toBe(false);
      expect(await isCircuitOpen(projectId, 1_000)).toBe(false);
    }
    const opened = await recordCircuitFailure(projectId, 1_000);
    expect(opened.opened).toBe(true);
    expect(await isCircuitOpen(projectId, 1_000)).toBe(true);
    expect(await isCircuitOpen(projectId, 1_000 + 11 * 60 * 1000)).toBe(false);
  });

  it('resets on success', async () => {
    const projectId = 'proj-circuit-2';
    await recordCircuitFailure(projectId);
    await recordCircuitSuccess(projectId);
    expect((await getCircuitState(projectId)).failures).toBe(0);
  });

  it('fails open to Warn semantics (never Block) when open', async () => {
    // Contract of the breaker: when open, agentic path must Warn, not Block.
    // evaluateRubric returns outcome warn + reason circuit_open.
    const projectId = 'proj-circuit-fail-open';
    for (let i = 0; i < RUBRIC_CIRCUIT_FAILURES; i += 1) {
      await recordCircuitFailure(projectId, 1_000);
    }
    expect(await isCircuitOpen(projectId, 1_000)).toBe(true);
    // The gate mapping is tested in integration; here we assert the breaker
    // itself is open so the warn path is reachable.
    expect((await getCircuitState(projectId)).openUntil).not.toBeNull();
  });
});
