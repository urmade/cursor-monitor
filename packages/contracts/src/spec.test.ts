import { describe, expect, it } from 'vitest';
import { SpecContentSchema } from './spec';

describe('SpecContentSchema', () => {
  it('defaults summary to empty string', () => {
    expect(SpecContentSchema.parse({})).toEqual({ summary: '' });
  });

  it('accepts optional fields', () => {
    const parsed = SpecContentSchema.parse({
      summary: 'hello',
      acceptanceCriteria: ['a'],
      openQuestions: ['q'],
    });
    expect(parsed.summary).toBe('hello');
    expect(parsed.acceptanceCriteria).toEqual(['a']);
  });

  it('rejects oversized summary', () => {
    expect(() =>
      SpecContentSchema.parse({ summary: 'x'.repeat(20_001) }),
    ).toThrow();
  });
});
