import { describe, expect, it } from 'vitest';
import { conversationBranchKey } from './branches';

describe('conversationBranchKey', () => {
  it('uses the branch name when a project has one repository', () => {
    expect(
      conversationBranchKey(
        { branch: 'main', originatingRepository: 'acme/app' },
        1,
      ),
    ).toBe('main');
  });

  it('prefixes the originating repository when a project has multiple sources', () => {
    expect(
      conversationBranchKey(
        { branch: 'main', originatingRepository: 'acme/app' },
        2,
      ),
    ).toBe('acme/app/main');
  });
});
