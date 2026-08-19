import { describe, expect, it } from 'vitest';
import { repositoryPath } from './paths';

describe('paths', () => {
  it('builds repository URLs', () => {
    expect(repositoryPath('acme/app')).toBe('/repositories/acme%2Fapp');
  });
});
