import { v7 as uuidv7 } from 'uuid';

/** Application-side UUIDv7 for time-ordered primary keys. */
export function newId(): string {
  return uuidv7();
}
