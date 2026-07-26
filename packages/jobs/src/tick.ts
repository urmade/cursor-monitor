/** Cron tick scaffolding — Phase 1 wires real job handlers. */

export type TickResult = {
  ok: true;
  lastCronTick: string;
  message: string;
};

/** In-memory last tick for /api/health until a durable meta table exists. */
let lastCronTickMemory: string | null = null;

export function getLastCronTickMemory(): string | null {
  return lastCronTickMemory;
}

export async function recordLastCronTick(iso: string): Promise<void> {
  lastCronTickMemory = iso;
}

export async function readLastCronTick(): Promise<string | null> {
  return lastCronTickMemory;
}

export async function runCronTick(): Promise<TickResult> {
  const lastCronTick = new Date().toISOString();
  await recordLastCronTick(lastCronTick);
  return {
    ok: true,
    lastCronTick,
    message: 'no handlers registered',
  };
}
