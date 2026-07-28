import { desc, eq } from 'drizzle-orm';
import { appMeta, events, type Db } from '@nexus/db';

export type OutboxCursor = {
  occurredAt: string;
  eventId: string;
};

export const ATTENTION_DISPATCHER_CURSOR_KEY = 'attention_dispatcher_cursor';
/** @deprecated Legacy global key — migrated lazily to {@link webhookDispatcherCursorKey}. */
export const WEBHOOK_DISPATCHER_CURSOR_KEY_LEGACY = 'webhook_dispatcher_cursor';

export function webhookDispatcherCursorKey(orgId: string): string {
  return `webhook_dispatcher_cursor:${orgId}`;
}

export async function readOutboxCursor(
  db: Db,
  key: string,
): Promise<OutboxCursor | null> {
  const row = await db.query.appMeta.findFirst({
    where: eq(appMeta.key, key),
  });
  if (!row?.value) return null;
  const occurredAt = row.value.occurredAt;
  const eventId = row.value.eventId;
  if (typeof occurredAt !== 'string' || typeof eventId !== 'string') return null;
  return { occurredAt, eventId };
}

export async function writeOutboxCursor(
  db: Db,
  key: string,
  cursor: OutboxCursor,
): Promise<void> {
  await db
    .insert(appMeta)
    .values({
      key,
      value: { occurredAt: cursor.occurredAt, eventId: cursor.eventId },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: {
        value: { occurredAt: cursor.occurredAt, eventId: cursor.eventId },
        updatedAt: new Date(),
      },
    });
}

/** Skip historical backlog — point consumer at the latest event (or empty). */
export async function advanceOutboxCursorToLatest(
  db: Db,
  key: string,
  options?: { orgId?: string },
): Promise<void> {
  const latest = await db.query.events.findMany({
    where: options?.orgId ? eq(events.orgId, options.orgId) : undefined,
    orderBy: [desc(events.occurredAt), desc(events.id)],
    limit: 1,
  });
  if (!latest[0]) return;
  await writeOutboxCursor(db, key, {
    occurredAt: latest[0].occurredAt.toISOString(),
    eventId: latest[0].id,
  });
}

export async function advanceWebhookOutboxCursorToLatest(
  db: Db,
  orgId: string,
): Promise<void> {
  await advanceOutboxCursorToLatest(db, webhookDispatcherCursorKey(orgId), { orgId });
}

/**
 * Per-org webhook dispatcher cursor. Legacy global key is migrated only via
 * {@link migrateLegacyWebhookDispatcherCursor}, not lazily on read.
 */
export async function resolveWebhookDispatcherCursor(
  db: Db,
  orgId: string,
): Promise<OutboxCursor | null> {
  const key = webhookDispatcherCursorKey(orgId);
  return readOutboxCursor(db, key);
}

/**
 * On first webhook endpoint for an org, position the cursor at the org's current head
 * so historical public events are not delivered as a replay incident.
 */
export async function ensureWebhookDispatcherCursorInitialized(
  db: Db,
  orgId: string,
): Promise<void> {
  const key = webhookDispatcherCursorKey(orgId);
  if (await readOutboxCursor(db, key)) return;
  await advanceWebhookOutboxCursorToLatest(db, orgId);
}

/** One-time style migration: copy the legacy global cursor to every org missing a per-org row. */
export async function migrateLegacyWebhookDispatcherCursor(db: Db): Promise<void> {
  const legacy = await readOutboxCursor(db, WEBHOOK_DISPATCHER_CURSOR_KEY_LEGACY);
  if (!legacy) return;
  const orgRows = await db.query.orgs.findMany();
  for (const org of orgRows) {
    const key = webhookDispatcherCursorKey(org.id);
    const existing = await readOutboxCursor(db, key);
    if (!existing) {
      await writeOutboxCursor(db, key, legacy);
    }
  }
  if (orgRows.length > 0) {
    const checks = await Promise.all(
      orgRows.map((org) => readOutboxCursor(db, webhookDispatcherCursorKey(org.id))),
    );
    if (checks.every(Boolean)) {
      await db.delete(appMeta).where(eq(appMeta.key, WEBHOOK_DISPATCHER_CURSOR_KEY_LEGACY));
    }
  }
}

export function compareEventOrder(
  a: { occurredAt: Date; id: string },
  b: OutboxCursor,
): number {
  const aTime = a.occurredAt.toISOString();
  if (aTime > b.occurredAt) return 1;
  if (aTime < b.occurredAt) return -1;
  if (a.id > b.eventId) return 1;
  if (a.id < b.eventId) return -1;
  return 0;
}

export function isAfterCursor(
  row: { occurredAt: Date; id: string },
  cursor: OutboxCursor | null,
): boolean {
  if (!cursor) return true;
  return compareEventOrder(row, cursor) > 0;
}
