import { randomUUID } from 'node:crypto';

export type * from './adapter';
export {
  closeDatabase,
  getDatabase,
  getDatabaseAdapterInfo,
} from './runtime';

export function newId(): string {
  return randomUUID();
}
