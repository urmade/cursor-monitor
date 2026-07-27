import type { Db } from '@nexus/db';
import type { JobRow } from './queue';

export type JobHandler = (
  db: Db,
  job: JobRow,
) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export function getJobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}

export function listRegisteredKinds(): string[] {
  return [...handlers.keys()];
}

/** Built-in no-op used to prove the scheduler path on preview. */
registerJobHandler('noop', async () => {
  // intentionally empty
});
