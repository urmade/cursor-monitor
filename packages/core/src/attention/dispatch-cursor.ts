import { eq } from 'drizzle-orm';
import { appMeta } from '@nexus/db';
import type { ServiceContext } from '../context';

export type AttentionDispatchCursor = {
  occurredAt: string;
  id: string;
};

function cursorKey(orgId: string): string {
  return `attention_dispatcher_cursor:${orgId}`;
}

export async function readAttentionDispatchCursor(
  ctx: ServiceContext,
): Promise<AttentionDispatchCursor | null> {
  const row = await ctx.db.query.appMeta.findFirst({
    where: eq(appMeta.key, cursorKey(ctx.orgId)),
  });
  const v = row?.value as AttentionDispatchCursor | undefined;
  if (v?.occurredAt && v?.id) return v;
  return null;
}

export async function writeAttentionDispatchCursor(
  ctx: ServiceContext,
  cursor: AttentionDispatchCursor,
): Promise<void> {
  const key = cursorKey(ctx.orgId);
  await ctx.db
    .insert(appMeta)
    .values({
      key,
      value: cursor,
      updatedAt: ctx.clock(),
    })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: cursor, updatedAt: ctx.clock() },
    });
}
