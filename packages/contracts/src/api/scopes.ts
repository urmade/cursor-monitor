import { z } from 'zod';

/** Public API token scopes (Phase 8). */
export const ApiScopeSchema = z.enum([
  'projects:read',
  'items:read',
  'items:write',
  'items:transition',
  'runs:write',
  'questions:write',
  'webhooks:manage',
]);

export type ApiScope = z.infer<typeof ApiScopeSchema>;

export const API_SCOPES: ApiScope[] = [...ApiScopeSchema.options];

export function parseApiScopes(raw: string[]): ApiScope[] {
  return raw.map((s) => ApiScopeSchema.parse(s));
}
