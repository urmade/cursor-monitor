/**
 * Best-effort GitHub PR title lookup for Monitoring.
 *
 * Uses `GITHUB_TOKEN` or `GH_TOKEN` when set (needed for private repos).
 * Falls back to unauthenticated requests for public repos. Failures are
 * silent — callers keep the `#N` / conversation-name fallback.
 */
import { kvGet, kvSet } from '@nexus/core';
import { parseGithubPrRef, type GithubPrRef } from '../lib/monitoring-format';

const TITLE_TTL_SEC = 30 * 60;
const TITLE_NEG_TTL_SEC = 5 * 60;
const FETCH_CONCURRENCY = 6;

type MemoryEntry = { expiresAt: number; title: string | null };
const memory = new Map<string, MemoryEntry>();

function cacheKey(ref: GithubPrRef): string {
  return `monitor:v1:pr-title:${ref.owner}/${ref.repo}#${ref.number}`;
}

function githubToken(): string | null {
  const raw =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || '';
  return raw.length > 0 ? raw : null;
}

async function readCached(ref: GithubPrRef): Promise<string | null | undefined> {
  const key = cacheKey(ref);
  const mem = memory.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.title;

  const raw = await kvGet(key);
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { title: string | null; expiresAt: number };
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
      return undefined;
    }
    memory.set(key, { title: parsed.title, expiresAt: parsed.expiresAt });
    return parsed.title;
  } catch {
    return undefined;
  }
}

async function writeCached(
  ref: GithubPrRef,
  title: string | null,
  ttlSec: number,
): Promise<void> {
  const key = cacheKey(ref);
  const expiresAt = Date.now() + ttlSec * 1000;
  memory.set(key, { title, expiresAt });
  await kvSet(key, JSON.stringify({ title, expiresAt }), ttlSec);
}

async function fetchTitle(ref: GithubPrRef): Promise<string | null> {
  const cached = await readCached(ref);
  if (cached !== undefined) return cached;

  const token = githubToken();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nexus-monitoring',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) {
      await writeCached(ref, null, TITLE_NEG_TTL_SEC);
      return null;
    }
    const body = (await res.json()) as { title?: unknown };
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim()
        : null;
    await writeCached(ref, title, title ? TITLE_TTL_SEC : TITLE_NEG_TTL_SEC);
    return title;
  } catch {
    await writeCached(ref, null, TITLE_NEG_TTL_SEC);
    return null;
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * Resolve GitHub PR titles for a set of PR URLs.
 * Returns a map keyed by the original URL string (and the canonical form).
 */
export async function resolveGithubPrTitles(
  prUrls: Iterable<string>,
): Promise<Map<string, string>> {
  const byCanonical = new Map<string, GithubPrRef>();
  const originals = new Map<string, string[]>(); // canonical → original urls

  for (const url of prUrls) {
    const ref = parseGithubPrRef(url);
    if (!ref) continue;
    byCanonical.set(ref.prUrl, ref);
    const list = originals.get(ref.prUrl) ?? [];
    list.push(url);
    originals.set(ref.prUrl, list);
  }

  const refs = [...byCanonical.values()];
  const titles = await mapPool(refs, FETCH_CONCURRENCY, fetchTitle);

  const out = new Map<string, string>();
  refs.forEach((ref, i) => {
    const title = titles[i];
    if (!title) return;
    out.set(ref.prUrl, title);
    for (const original of originals.get(ref.prUrl) ?? []) {
      out.set(original, title);
    }
  });
  return out;
}

/** Test helper. */
export function resetGithubPrTitleMemoryCache(): void {
  memory.clear();
}
