import {
  createContext,
  createFlagReader,
  upsertUserFromPassport,
  type ServiceContext,
} from '@nexus/core';
import { getDb } from '@nexus/db';
import { currentUser, type AppUser } from './identity';

export type Session = {
  user: AppUser;
  userId: string;
  orgId: string;
  ctx: ServiceContext;
};

export async function requireSession(): Promise<Session> {
  const user = await currentUser();
  if (!user) {
    throw new Error('Unauthenticated');
  }
  const db = getDb();
  const { userId, orgId } = await upsertUserFromPassport(db, {
    externalSub: user.externalSub,
    email: user.email,
    name: user.name,
  });
  const ctx = createContext({
    db,
    orgId,
    actor: { kind: 'human', userId },
    flags: createFlagReader(db),
  });
  return { user, userId, orgId, ctx };
}

export async function optionalSession(): Promise<Session | null> {
  try {
    return await requireSession();
  } catch {
    return null;
  }
}
