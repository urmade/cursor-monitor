import { desc, eq } from 'drizzle-orm';
import { events } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export async function listProjectEvents(
  ctx: ServiceContext,
  projectId: string,
  opts: {
    subjectId?: string;
    /** When set, also include events whose payload.workItemId matches. */
    workItemId?: string;
    limit?: number;
  } = {},
): Promise<Result<(typeof events.$inferSelect)[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'audit.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }

  const rows = await ctx.db.query.events.findMany({
    where: eq(events.projectId, projectId),
    orderBy: [desc(events.occurredAt)],
    limit: Math.max(opts.limit ?? 100, 200),
  });

  let filtered = rows;
  if (opts.workItemId || opts.subjectId) {
    const id = opts.workItemId ?? opts.subjectId!;
    filtered = rows.filter((e) => {
      if (e.subjectId === id) return true;
      const payload = e.payload as { workItemId?: string };
      return payload.workItemId === id;
    });
  }

  return ok(filtered.slice(0, opts.limit ?? 100));
}
