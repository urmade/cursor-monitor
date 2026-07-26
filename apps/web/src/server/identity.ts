import { headers } from 'next/headers';
import { decodeJwt } from 'jose';

export type AppUser = {
  externalSub: string;
  email?: string;
  name?: string;
  rawClaims: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse Passport identity from x-vercel-oidc-passport-token.
 * Local fallback only when !process.env.VERCEL.
 */
export async function currentUser(): Promise<AppUser | null> {
  const h = await headers();
  const token = h.get('x-vercel-oidc-passport-token');

  if (!token) {
    return devFallbackUser();
  }

  try {
    // Within the Passport-protected Vercel boundary the edge already verified
    // the session; we decode claims and require external_sub.
    const claims = decodeJwt(token);
    const externalSub = claims['external_sub'];
    if (typeof externalSub !== 'string' || externalSub.length === 0) {
      return null;
    }

    const email =
      typeof claims.email === 'string' ? claims.email : undefined;
    const name = typeof claims.name === 'string' ? claims.name : undefined;

    return {
      externalSub,
      email,
      name,
      rawClaims: claims as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function devFallbackUser(): AppUser | null {
  if (process.env.VERCEL) {
    return null;
  }
  return {
    externalSub: 'local-dev-user',
    email: 'local@example.com',
    name: 'Local Dev',
    rawClaims: { source: 'dev-fallback' },
  };
}

export function describeUser(user: AppUser): Record<string, unknown> {
  const out: Record<string, unknown> = {
    external_sub: user.externalSub,
  };
  if (user.email) out.email = user.email;
  if (user.name) out.name = user.name;
  if (isRecord(user.rawClaims)) {
    for (const key of ['sub', 'scope', 'connector_id']) {
      if (key in user.rawClaims) out[key] = user.rawClaims[key];
    }
  }
  return out;
}
