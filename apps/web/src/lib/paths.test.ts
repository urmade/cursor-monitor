import { describe, expect, it } from 'vitest';
import { renamePath, repositoryPath, safeInternalPath } from './paths';

describe('paths', () => {
  it('builds repository and shared rename URLs', () => {
    expect(repositoryPath('acme/app')).toBe('/repositories/acme%2Fapp');
    expect(renamePath('acme/app')).toBe('/repositories/acme%2Fapp/rename');
    expect(renamePath('acme/app', { conversation: 'conversation-1' })).toBe(
      '/repositories/acme%2Fapp/rename?conversation=conversation-1',
    );
    expect(renamePath('acme/app', { branch: 'acme/app/main' })).toBe(
      '/repositories/acme%2Fapp/rename?branch=acme%2Fapp%2Fmain',
    );
  });

  it('accepts only internal return paths', () => {
    expect(safeInternalPath('/repositories/acme%2Fapp', '/')).toBe(
      '/repositories/acme%2Fapp',
    );
    expect(safeInternalPath('https://evil.test', '/')).toBe('/');
    expect(safeInternalPath('//evil.test', '/')).toBe('/');
    expect(safeInternalPath('\\evil', '/')).toBe('/');
  });
});
