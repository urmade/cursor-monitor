export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

type CounterStore = {
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<void>;
};

const memory = new Map<string, { count: number; expiresAt: number }>();

const memoryStore: CounterStore = {
  async incr(key) {
    const now = Date.now();
    const cur = memory.get(key);
    if (!cur || cur.expiresAt <= now) {
      memory.set(key, { count: 1, expiresAt: now + 60_000 });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  },
  async expire(key, seconds) {
    const cur = memory.get(key);
    if (cur) cur.expiresAt = Date.now() + seconds * 1000;
  },
};

let redisStore: CounterStore | null = null;

/** Minimal Upstash REST client — avoids pulling @upstash/redis into @nexus/core (drizzle dup). */
function createUpstashStore(url: string, token: string): CounterStore {
  async function command(args: unknown[]): Promise<unknown> {
    const res = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([args]),
    });
    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}`);
    }
    const json = (await res.json()) as Array<{ result?: unknown }>;
    return json[0]?.result;
  }

  return {
    async incr(key) {
      // Prefer single INCR via pipeline-compatible endpoint.
      const res = await fetch(
        `${url.replace(/\/$/, '')}/incr/${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        // Fallback pipeline
        const result = await command(['INCR', key]);
        return Number(result ?? 0);
      }
      const json = (await res.json()) as { result?: number };
      return Number(json.result ?? 0);
    },
    async expire(key, seconds) {
      await fetch(
        `${url.replace(/\/$/, '')}/expire/${encodeURIComponent(key)}/${seconds}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      ).catch(async () => {
        await command(['EXPIRE', key, seconds]);
      });
    },
  };
}

function getStore(): CounterStore {
  if (redisStore) return redisStore;
  const url =
    process.env.REDIS_KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.REDIS_KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    redisStore = createUpstashStore(url, token);
    return redisStore;
  }
  return memoryStore;
}

/** Counter with configurable window (seconds). Falls back to in-process when Redis unset. */
export async function checkRateLimitWindow(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const store = getStore();
  const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  try {
    const count = await store.incr(bucket);
    if (count === 1) await store.expire(bucket, windowSec * 2);
    const remaining = Math.max(0, limit - count);
    return {
      allowed: count <= limit,
      remaining,
      retryAfterSec: count <= limit ? 0 : windowSec,
    };
  } catch {
    const count = await memoryStore.incr(bucket);
    if (count === 1) await memoryStore.expire(bucket, windowSec * 2);
    const capped = Math.min(limit, 30);
    return {
      allowed: count <= capped,
      remaining: Math.max(0, capped - count),
      retryAfterSec: count <= capped ? 0 : windowSec,
    };
  }
}

/** Sliding 60s window counter. Falls back to in-process when Redis is unset. */
export async function checkRateLimit(
  key: string,
  limitPerMinute: number,
): Promise<RateLimitResult> {
  return checkRateLimitWindow(key, limitPerMinute, 60);
}

/** Test helper — clears in-memory counters. */
export function resetMemoryRateLimits(): void {
  memory.clear();
}
