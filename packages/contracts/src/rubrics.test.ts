import { describe, expect, it } from 'vitest';
import { RubricCriteriaSchema } from './rubrics';

describe('RubricCriteriaSchema', () => {
  it('requires at least one criterion (min 1)', () => {
    expect(RubricCriteriaSchema.safeParse([]).success).toBe(false);
    expect(
      RubricCriteriaSchema.safeParse([
        {
          key: 'ok',
          statement: 'is ok',
          weight: 'must',
        },
      ]).success,
    ).toBe(true);
  });
});
