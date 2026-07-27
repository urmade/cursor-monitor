import { describe, expect, it } from 'vitest';
import { computeTransitionDirection } from './transition-direction';

describe('computeTransitionDirection', () => {
  it('initial when from is null', () => {
    expect(computeTransitionDirection(null, 100)).toBe('initial');
  });
  it('forward when to > from', () => {
    expect(computeTransitionDirection(100, 200)).toBe('forward');
  });
  it('backward when to < from', () => {
    expect(computeTransitionDirection(300, 100)).toBe('backward');
  });
  it('lateral when equal', () => {
    expect(computeTransitionDirection(200, 200)).toBe('lateral');
  });
});
