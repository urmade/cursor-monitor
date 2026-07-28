/**
 * Minimal Redis key/value helpers (Upstash REST) with in-process fallback.
 * Shared by the hourly cap and the agentic circuit breaker.
 */

type KvStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSec?: number) => Promise<void>;
  del: (key: string) => Promise<void>;
};

const memory = new Map<string, { value: string; expiresAt: number | null }>();

const memoryStore: KvStore = {
  async get(key) {
    const cur = memory.get(key);
    if (!cur) return null;
    if (cur.expiresAt != null && cur.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    return cur.value;
  },
  async set(key, value, ttlSec) {
    memory.set(key, {
      value,
      expiresAt: ttlSec != null ? Date.now() + ttlSec * 1000 : null,
    });
  },
  async del(key) {
    memory.delete(key);
  },
};

let redisStore: KvStore | null = null;

function createUpstashKv(url: string, token: string): KvStore {
  const base = url.replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return {
    async get(key) {
      const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: string | null };
      return json.result ?? null;
    },
    async set(key, value, ttlSec) {
      if (ttlSec != null) {
        await fetch(`${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSec}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        return;
      }
      await fetch(`${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    async del(key) {
      await fetch(`${base}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers,
      });
    },
  };
}

function getStore(): KvStore {
  if (redisStore) return redisStore;
  const url =
    process.env.REDIS_KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.REDIS_KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    redisStore = createUpstashKv(url, token);
    return redisStore;
  }
  return memoryStore;
}

export async function kvGet(key: string): Promise<string | null> {
  try {
    return await getStore().get(key);
  } catch {
    return memoryStore.get(key);
  }
}

export async function kvSet(
  key: string,
  value: string,
  ttlSec?: number,
): Promise<void> {
  try {
    await getStore().set(key, value, ttlSec);
  } catch {
    await memoryStore.set(key, value, ttlSec);
  }
}

export async function kvDel(key: string): Promise<void> {
  try {
    await getStore().del(key);
  } catch {
    await memoryStore.del(key);
  }
}

/** Test helper — clears in-memory KV. */
export function resetMemoryKv(): void {
  memory.clear();
}
