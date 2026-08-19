import { randomUUID } from 'node:crypto';

export * from './client';
export * from './config';
export * from './schema';

export function newId(): string {
  return randomUUID();
}
