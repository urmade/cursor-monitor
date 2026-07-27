import { eq } from 'drizzle-orm';
import { newId, orgs, users, type Db } from '@nexus/db';

export type PassportClaims = {
  externalSub: string;
  email?: string;
  name?: string;
};

const DEFAULT_ORG_SLUG = 'anysphere';

/**
 * Upsert a users row from Passport claims. Ensures a default org exists.
 * Returns the durable user id used as Actor.userId.
 */
export async function upsertUserFromPassport(
  db: Db,
  claims: PassportClaims,
): Promise<{ userId: string; orgId: string }> {
  const existing = await db.query.users.findFirst({
    where: eq(users.externalSub, claims.externalSub),
  });

  if (existing) {
    await db
      .update(users)
      .set({
        email: claims.email ?? existing.email,
        displayName: claims.name ?? existing.displayName,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
    return { userId: existing.id, orgId: existing.orgId };
  }

  let org = await db.query.orgs.findFirst({
    where: eq(orgs.slug, DEFAULT_ORG_SLUG),
  });
  if (!org) {
    const orgId = newId();
    await db.insert(orgs).values({
      id: orgId,
      name: 'Anysphere',
      slug: DEFAULT_ORG_SLUG,
    });
    org = { id: orgId, name: 'Anysphere', slug: DEFAULT_ORG_SLUG } as typeof org & {
      id: string;
    };
  }

  const userId = newId();
  await db.insert(users).values({
    id: userId,
    orgId: org!.id,
    externalSub: claims.externalSub,
    email: claims.email ?? null,
    displayName: claims.name ?? null,
    lastSeenAt: new Date(),
  });

  return { userId, orgId: org!.id };
}
