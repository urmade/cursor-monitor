import { describe, expect, it } from 'vitest';
import { nextPollDelaySec } from './lifecycle';
import { renderPromptTemplate, DEFAULT_PROMPT_TEMPLATE } from './prompt';

describe('nextPollDelaySec', () => {
  it('is 5s in the first minute', () => {
    expect(nextPollDelaySec(0, 10_000)).toBe(5);
  });
  it('is 15s between 1 and 5 minutes', () => {
    expect(nextPollDelaySec(5, 90_000)).toBe(15);
  });
  it('is 60s after 5 minutes', () => {
    expect(nextPollDelaySec(20, 400_000)).toBe(60);
  });
});

describe('renderPromptTemplate', () => {
  it('substitutes ticket/stage/run vars', () => {
    const text = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      ticket: { id: 'tid', key: 'A-1', title: 'T' },
      stage: { name: 'Scoping', key: 'scoping' },
      run: { nonce: 'abc', id: 'rid' },
    });
    expect(text).toContain('A-1');
    expect(text).toContain('tid');
    expect(text).toContain('Scoping');
    expect(text).toContain('abc');
    expect(text).toContain('post_stage_report');
  });
});
