import { decodeJwt } from 'jose';
import { headers } from 'next/headers';

export type AdminIdentity = {
  id: string;
  email: string | null;
  name: string | null;
};

export async function currentAdmin(): Promise<AdminIdentity | null> {
  const token = (await headers()).get('x-vercel-oidc-passport-token');
  if (!token) {
    return process.env.VERCEL
      ? null
      : { id: 'local-development', email: 'local@example.com', name: 'Local admin' };
  }
  try {
    const claims = decodeJwt(token);
    const id = claims['external_sub'];
    if (typeof id !== 'string' || !id.trim()) return null;
    return {
      id,
      email: typeof claims.email === 'string' ? claims.email : null,
      name: typeof claims.name === 'string' ? claims.name : null,
    };
  } catch {
    return null;
  }
}

export async function requireAdmin(): Promise<AdminIdentity> {
  const admin = await currentAdmin();
  if (!admin) throw new Error('Unauthenticated');
  return admin;
}
