import type { Db } from '@nexus/db';
import { getDb } from '@nexus/db';

/** Pooled DB handle; call per test so a prior file's `closeDb()` does not leave a dead client. */
export function testDb(): Db {
  return getDb();
}
