import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetGithubPrTitleMemoryCache,
  resolveGithubPrTitles,
} from '../server/github-pr-titles';

describe('resolveGithubPrTitles', () => {
  afterEach(() => {
    resetGithubPrTitleMemoryCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches and maps PR titles by URL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/repos/internalsphere/nexus/pulls/28');
      return new Response(JSON.stringify({ title: 'Monitoring rework' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const titles = await resolveGithubPrTitles([
      'https://github.com/internalsphere/nexus/pull/28',
      'https://github.com/internalsphere/nexus/pull/28',
    ]);

    expect(titles.get('https://github.com/internalsphere/nexus/pull/28')).toBe(
      'Monitoring rework',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores non-GitHub URLs and failed lookups', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const titles = await resolveGithubPrTitles([
      'https://gitlab.com/acme/x/-/merge_requests/1',
      'https://github.com/acme/x/pull/9',
    ]);

    expect(titles.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
