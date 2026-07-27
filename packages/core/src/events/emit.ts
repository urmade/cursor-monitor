import { NewEventSchema, type NewEvent } from '@nexus/contracts';
import { events, newId, type Db } from '@nexus/db';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function emit(tx: Tx | Db, e: NewEvent): Promise<string> {
  const parsed = NewEventSchema.parse(e);
  const id = newId();
  await tx.insert(events).values({
    id,
    orgId: parsed.orgId,
    projectId: parsed.projectId ?? null,
    type: parsed.type,
    subjectType: parsed.subjectType,
    subjectId: parsed.subjectId,
    actor: parsed.actor,
    payload: parsed.payload ?? {},
    occurredAt: parsed.occurredAt ?? new Date(),
  });
  return id;
}
