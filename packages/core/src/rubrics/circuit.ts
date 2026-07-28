import {
  RUBRIC_CIRCUIT_COOLDOWN_MS,
  RUBRIC_CIRCUIT_FAILURES,
} from '@nexus/contracts';
import { kvDel, kvGet, kvSet, resetMemoryKv } from '../redis/kv';

export type CircuitState = {
  failures: number;
  openUntil: number | null;
};

export function circuitKey(projectId: string): string {
  return `agentic:${projectId}`;
}

function redisKey(projectId: string): string {
  return `circuit:${circuitKey(projectId)}`;
}

async function loadState(projectId: string): Promise<CircuitState> {
  const raw = await kvGet(redisKey(projectId));
  if (!raw) return { failures: 0, openUntil: null };
  try {
    const parsed = JSON.parse(raw) as CircuitState;
    return {
      failures: Number(parsed.failures ?? 0),
      openUntil:
        parsed.openUntil == null ? null : Number(parsed.openUntil),
    };
  } catch {
    return { failures: 0, openUntil: null };
  }
}

async function saveState(
  projectId: string,
  state: CircuitState,
): Promise<void> {
  const ttlSec =
    state.openUntil != null
      ? Math.max(
          60,
          Math.ceil((state.openUntil - Date.now()) / 1000) + 60,
        )
      : 24 * 3600;
  await kvSet(redisKey(projectId), JSON.stringify(state), ttlSec);
}

export async function isCircuitOpen(
  projectId: string,
  now = Date.now(),
): Promise<boolean> {
  const state = await loadState(projectId);
  if (!state.openUntil) return false;
  if (state.openUntil <= now) {
    // Half-open: allow one try
    await saveState(projectId, { failures: 0, openUntil: null });
    return false;
  }
  return true;
}

export async function recordCircuitSuccess(projectId: string): Promise<void> {
  await saveState(projectId, { failures: 0, openUntil: null });
}

export async function recordCircuitFailure(
  projectId: string,
  now = Date.now(),
): Promise<{ opened: boolean; openUntil: number | null }> {
  const cur = await loadState(projectId);
  cur.failures += 1;
  if (cur.failures >= RUBRIC_CIRCUIT_FAILURES) {
    cur.openUntil = now + RUBRIC_CIRCUIT_COOLDOWN_MS;
    await saveState(projectId, cur);
    return { opened: true, openUntil: cur.openUntil };
  }
  await saveState(projectId, cur);
  return { opened: false, openUntil: null };
}

export async function getCircuitState(
  projectId: string,
): Promise<CircuitState> {
  return loadState(projectId);
}

/** Test helper. */
export async function resetCircuits(): Promise<void> {
  resetMemoryKv();
  // Also clear any leftover keys for common test project ids is unnecessary —
  // memory store wipe covers the in-process path.
  void kvDel;
}
