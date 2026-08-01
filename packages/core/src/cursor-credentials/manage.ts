import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  cursorOrganisationApiKeys,
  cursorOrganisations,
  newId,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { err, ok, type Result } from '../result';
import { normalizeCursorBaseUrl } from './base-url';
import {
  decryptCursorApiKey,
  encryptCursorApiKey,
  fingerprintCursorApiKey,
  maskCursorApiKey,
} from './secret-crypto';

export {
  DEFAULT_CURSOR_API_BASE_URL,
  CURSOR_API_BASE_URL_ALLOWLIST_ENV,
  allowedCursorApiBaseUrls,
  normalizeCursorBaseUrl,
  type NormalizeCursorBaseUrlOptions,
} from './base-url';

export type CursorApiKeyKind = 'user' | 'service_account';

export type CursorOrganisationRow = typeof cursorOrganisations.$inferSelect;
export type CursorOrganisationApiKeyRow =
  typeof cursorOrganisationApiKeys.$inferSelect;

export type DecryptedCursorApiKey = {
  id: string;
  cursorOrganisationId: string;
  label: string;
  keyKind: CursorApiKeyKind;
  apiKey: string;
  fingerprint: string;
  hint: string;
  identityLabel: string | null;
  createdByUserId: string | null;
  lastValidatedAt: Date | null;
  createdAt: Date;
};

export type DecryptedCursorOrganisation = {
  id: string;
  label: string;
  organizationId: string | null;
  baseUrl: string;
  orgApiKey: string | null;
  orgApiKeyHint: string | null;
  hasOrgApiKey: boolean;
  createdByUserId: string | null;
  apiKeys: DecryptedCursorApiKey[];
  createdAt: Date;
  updatedAt: Date;
};

export type CursorOrganisationView = {
  id: string;
  label: string;
  organizationId: string | null;
  baseUrl: string;
  hasOrgApiKey: boolean;
  orgApiKeyHint: string | null;
  /** Current human owns this connection (edit metadata / org admin key). */
  canManage: boolean;
  /** Current human may delete this connection. */
  canRemove: boolean;
  keys: Array<{
    id: string;
    label: string;
    keyKind: CursorApiKeyKind;
    fingerprint: string;
    hint: string;
    identityLabel: string | null;
    lastValidatedAt: Date | null;
    createdAt: Date;
    /** Current human may revoke this attached key. */
    canRemove: boolean;
  }>;
  createdAt: Date;
  updatedAt: Date;
};

function requireHumanUserId(
  ctx: ServiceContext,
): Result<string, CoreError> {
  if (ctx.actor.kind !== 'human') {
    return err(
      coreError(
        'forbidden',
        'Only signed-in users can manage Cursor credentials',
      ),
    );
  }
  return ok(ctx.actor.userId);
}

function isOwnedBy(createdByUserId: string | null, userId: string): boolean {
  return createdByUserId !== null && createdByUserId === userId;
}

function ownershipFlags(
  ctx: ServiceContext,
  createdByUserId: string | null,
): { canManage: boolean; canRemove: boolean } {
  const userId = ctx.actor.kind === 'human' ? ctx.actor.userId : null;
  const owned = userId !== null && isOwnedBy(createdByUserId, userId);
  return { canManage: owned, canRemove: owned };
}

function normalizeLabel(raw: string, fallback: string): string {
  const value = raw.trim();
  return value || fallback;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === '23505';
}

async function loadOrgOrError(
  ctx: ServiceContext,
  organisationId: string,
): Promise<Result<CursorOrganisationRow, CoreError>> {
  const row = await ctx.db.query.cursorOrganisations.findFirst({
    where: and(
      eq(cursorOrganisations.id, organisationId),
      eq(cursorOrganisations.orgId, ctx.orgId),
    ),
  });
  if (!row) return err(coreError('not_found', 'Cursor organisation not found'));
  return ok(row);
}

function decryptOrgApiKey(row: CursorOrganisationRow): string | null {
  if (!row.orgApiKeyEncrypted) return null;
  return decryptCursorApiKey(row.orgApiKeyEncrypted, {
    purpose: 'org-admin-api-key',
    orgId: row.orgId,
    recordId: row.id,
  });
}

function toDecryptedKey(row: CursorOrganisationApiKeyRow): DecryptedCursorApiKey {
  return {
    id: row.id,
    cursorOrganisationId: row.cursorOrganisationId,
    label: row.label,
    keyKind: row.keyKind,
    apiKey: decryptCursorApiKey(row.apiKeyEncrypted, {
      purpose: 'team-api-key',
      orgId: row.orgId,
      recordId: row.id,
    }),
    fingerprint: row.apiKeyFingerprint,
    hint: row.apiKeyHint,
    identityLabel: row.identityLabel,
    createdByUserId: row.createdByUserId,
    lastValidatedAt: row.lastValidatedAt,
    createdAt: row.createdAt,
  };
}

export async function listCursorOrganisations(
  ctx: ServiceContext,
): Promise<DecryptedCursorOrganisation[]> {
  const orgs = await ctx.db.query.cursorOrganisations.findMany({
    where: eq(cursorOrganisations.orgId, ctx.orgId),
    orderBy: [asc(cursorOrganisations.label), desc(cursorOrganisations.createdAt)],
  });
  if (orgs.length === 0) return [];

  const keys = await ctx.db.query.cursorOrganisationApiKeys.findMany({
    where: and(
      eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
      isNull(cursorOrganisationApiKeys.revokedAt),
    ),
    orderBy: [asc(cursorOrganisationApiKeys.createdAt)],
  });

  const keysByOrg = new Map<string, DecryptedCursorApiKey[]>();
  for (const key of keys) {
    const list = keysByOrg.get(key.cursorOrganisationId) ?? [];
    list.push(toDecryptedKey(key));
    keysByOrg.set(key.cursorOrganisationId, list);
  }

  return orgs.map((org) => {
    // Defense in depth for rows created before endpoint allowlisting or by
    // direct SQL: never let stored data choose a credential destination.
    const baseUrl = normalizeCursorBaseUrl(org.baseUrl);
    if (!baseUrl.ok) {
      throw new Error(
        `Stored Cursor API base URL is not allowed for organisation ${org.id}`,
      );
    }
    return {
      id: org.id,
      label: org.label,
      organizationId: org.organizationId,
      baseUrl: baseUrl.value,
      orgApiKey: decryptOrgApiKey(org),
      orgApiKeyHint: org.orgApiKeyHint,
      hasOrgApiKey: Boolean(org.orgApiKeyEncrypted),
      createdByUserId: org.createdByUserId,
      apiKeys: keysByOrg.get(org.id) ?? [],
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    };
  });
}

export async function listCursorOrganisationViews(
  ctx: ServiceContext,
): Promise<CursorOrganisationView[]> {
  const orgs = await ctx.db.query.cursorOrganisations.findMany({
    where: eq(cursorOrganisations.orgId, ctx.orgId),
    orderBy: [asc(cursorOrganisations.label), desc(cursorOrganisations.createdAt)],
  });
  if (orgs.length === 0) return [];

  // Settings needs only metadata. Do not decrypt every team/admin credential
  // merely to render masked hints and ownership controls.
  const keys = await ctx.db.query.cursorOrganisationApiKeys.findMany({
    where: and(
      eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
      isNull(cursorOrganisationApiKeys.revokedAt),
    ),
    orderBy: [asc(cursorOrganisationApiKeys.createdAt)],
  });
  const keysByOrg = new Map<string, CursorOrganisationApiKeyRow[]>();
  for (const key of keys) {
    const list = keysByOrg.get(key.cursorOrganisationId) ?? [];
    list.push(key);
    keysByOrg.set(key.cursorOrganisationId, list);
  }

  return orgs.map((org) => {
    const orgFlags = ownershipFlags(ctx, org.createdByUserId);
    const baseUrl = normalizeCursorBaseUrl(org.baseUrl);
    if (!baseUrl.ok) {
      throw new Error(
        `Stored Cursor API base URL is not allowed for organisation ${org.id}`,
      );
    }
    return {
      id: org.id,
      label: org.label,
      organizationId: org.organizationId,
      baseUrl: baseUrl.value,
      hasOrgApiKey: Boolean(org.orgApiKeyEncrypted),
      orgApiKeyHint: org.orgApiKeyHint,
      canManage: orgFlags.canManage,
      canRemove: orgFlags.canRemove,
      keys: (keysByOrg.get(org.id) ?? []).map((key) => ({
        id: key.id,
        label: key.label,
        keyKind: key.keyKind,
        fingerprint: key.apiKeyFingerprint,
        hint: key.apiKeyHint,
        identityLabel: key.identityLabel,
        lastValidatedAt: key.lastValidatedAt,
        createdAt: key.createdAt,
        canRemove: ownershipFlags(ctx, key.createdByUserId).canRemove,
      })),
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    };
  });
}

export async function upsertCursorOrganisation(
  ctx: ServiceContext,
  input: {
    id?: string | null;
    label: string;
    organizationId?: string | null;
    baseUrl?: string | null;
    /** Pass plaintext to set/replace; omit to keep; null to clear. */
    orgApiKey?: string | null;
  },
): Promise<Result<DecryptedCursorOrganisation, CoreError>> {
  const human = requireHumanUserId(ctx);
  if (!human.ok) return human;
  const userId = human.value;

  const label = normalizeLabel(input.label, '');
  if (!label) {
    return err(coreError('validation', 'Enter a name for this organisation connection.'));
  }
  const baseUrlResult = normalizeCursorBaseUrl(input.baseUrl);
  if (!baseUrlResult.ok) return baseUrlResult;
  const baseUrl = baseUrlResult.value;
  const organizationId = input.organizationId?.trim() || null;
  if (organizationId && !/^org_[A-Za-z0-9_]+$/.test(organizationId)) {
    return err(
      coreError(
        'validation',
        'Organisation id must look like org_… (from the Cursor dashboard URL).',
      ),
    );
  }

  const now = ctx.clock();

  let clearOrgApiKey = false;
  let orgApiKeyPlaintext: string | undefined;

  if (input.orgApiKey === null) {
    clearOrgApiKey = true;
  } else if (typeof input.orgApiKey === 'string' && input.orgApiKey.trim()) {
    const plaintext = input.orgApiKey.trim();
    if (plaintext.length < 20) {
      return err(coreError('validation', 'Organisation API key looks too short.'));
    }
    orgApiKeyPlaintext = plaintext;
  }

  function encryptOrgAdminKey(recordId: string): {
    orgApiKeyEncrypted: string;
    orgApiKeyFingerprint: string;
    orgApiKeyHint: string;
  } {
    const plaintext = orgApiKeyPlaintext!;
    return {
      orgApiKeyEncrypted: encryptCursorApiKey(plaintext, {
        purpose: 'org-admin-api-key',
        orgId: ctx.orgId,
        recordId,
      }),
      orgApiKeyFingerprint: fingerprintCursorApiKey(plaintext),
      orgApiKeyHint: maskCursorApiKey(plaintext),
    };
  }

  if (input.id) {
    const existing = await loadOrgOrError(ctx, input.id);
    if (!existing.ok) return existing;
    if (!isOwnedBy(existing.value.createdByUserId, userId)) {
      return err(
        coreError(
          'forbidden',
          'Only the member who created this organisation connection can update it',
        ),
      );
    }

    const keyFields = clearOrgApiKey
      ? {
          orgApiKeyEncrypted: null,
          orgApiKeyFingerprint: null,
          orgApiKeyHint: null,
        }
      : orgApiKeyPlaintext
        ? encryptOrgAdminKey(input.id)
        : undefined;

    await ctx.db
      .update(cursorOrganisations)
      .set({
        label,
        organizationId,
        baseUrl,
        ...(keyFields ?? {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(cursorOrganisations.id, input.id),
          eq(cursorOrganisations.orgId, ctx.orgId),
          eq(cursorOrganisations.createdByUserId, userId),
        ),
      );
  } else {
    const id = newId();
    const keyFields = clearOrgApiKey
      ? {
          orgApiKeyEncrypted: null as string | null,
          orgApiKeyFingerprint: null as string | null,
          orgApiKeyHint: null as string | null,
        }
      : orgApiKeyPlaintext
        ? encryptOrgAdminKey(id)
        : {
            orgApiKeyEncrypted: null as string | null,
            orgApiKeyFingerprint: null as string | null,
            orgApiKeyHint: null as string | null,
          };
    await ctx.db.insert(cursorOrganisations).values({
      id,
      orgId: ctx.orgId,
      label,
      organizationId,
      baseUrl,
      orgApiKeyEncrypted: keyFields.orgApiKeyEncrypted,
      orgApiKeyFingerprint: keyFields.orgApiKeyFingerprint,
      orgApiKeyHint: keyFields.orgApiKeyHint,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
    input = { ...input, id };
  }

  const listed = await listCursorOrganisations(ctx);
  const saved = listed.find((row) => row.id === input.id);
  if (!saved) {
    return err(coreError('invariant', 'Failed to load saved organisation'));
  }
  return ok(saved);
}

export async function deleteCursorOrganisation(
  ctx: ServiceContext,
  organisationId: string,
): Promise<Result<void, CoreError>> {
  const human = requireHumanUserId(ctx);
  if (!human.ok) return human;
  const existing = await loadOrgOrError(ctx, organisationId);
  if (!existing.ok) return existing;
  if (!isOwnedBy(existing.value.createdByUserId, human.value)) {
    return err(
      coreError(
        'forbidden',
        'Only the member who created this organisation connection can remove it',
      ),
    );
  }
  await ctx.db
    .delete(cursorOrganisations)
    .where(
      and(
        eq(cursorOrganisations.id, organisationId),
        eq(cursorOrganisations.orgId, ctx.orgId),
        eq(cursorOrganisations.createdByUserId, human.value),
      ),
    );
  return ok(undefined);
}

export async function deleteAllCursorOrganisations(
  ctx: ServiceContext,
): Promise<Result<number, CoreError>> {
  const human = requireHumanUserId(ctx);
  if (!human.ok) return human;
  const existing = await ctx.db.query.cursorOrganisations.findMany({
    where: and(
      eq(cursorOrganisations.orgId, ctx.orgId),
      eq(cursorOrganisations.createdByUserId, human.value),
    ),
  });
  if (existing.length === 0) return ok(0);
  await ctx.db
    .delete(cursorOrganisations)
    .where(
      and(
        eq(cursorOrganisations.orgId, ctx.orgId),
        eq(cursorOrganisations.createdByUserId, human.value),
      ),
    );
  return ok(existing.length);
}

export async function addCursorOrganisationApiKey(
  ctx: ServiceContext,
  input: {
    cursorOrganisationId: string;
    label: string;
    keyKind: CursorApiKeyKind;
    apiKey: string;
    identityLabel?: string | null;
  },
): Promise<Result<DecryptedCursorApiKey, CoreError>> {
  const human = requireHumanUserId(ctx);
  if (!human.ok) return human;
  const userId = human.value;

  const org = await loadOrgOrError(ctx, input.cursorOrganisationId);
  if (!org.ok) return org;

  const apiKey = input.apiKey.trim();
  if (apiKey.length < 20) {
    return err(
      coreError(
        'validation',
        'Paste a Cursor User or Team API key (at least 20 characters).',
      ),
    );
  }
  if (input.keyKind !== 'user' && input.keyKind !== 'service_account') {
    return err(coreError('validation', 'Key kind must be user or team.'));
  }

  const fingerprint = fingerprintCursorApiKey(apiKey);
  const now = ctx.clock();
  const label = normalizeLabel(
    input.label,
    input.keyKind === 'service_account' ? 'Team API key' : 'User API key',
  );
  const identityLabel = input.identityLabel?.trim() || null;
  const hint = maskCursorApiKey(apiKey);

  function encryptTeamKey(recordId: string): string {
    return encryptCursorApiKey(apiKey, {
      purpose: 'team-api-key',
      orgId: ctx.orgId,
      recordId,
    });
  }

  const existingSameFingerprint =
    await ctx.db.query.cursorOrganisationApiKeys.findFirst({
      where: and(
        eq(
          cursorOrganisationApiKeys.cursorOrganisationId,
          input.cursorOrganisationId,
        ),
        eq(cursorOrganisationApiKeys.apiKeyFingerprint, fingerprint),
      ),
    });

  if (existingSameFingerprint && !existingSameFingerprint.revokedAt) {
    return err(
      coreError(
        'conflict',
        `That API key is already attached as “${existingSameFingerprint.label}”.`,
      ),
    );
  }

  if (existingSameFingerprint?.revokedAt) {
    // Re-encrypt bound to the same API-key row id (revoke → reattach).
    const encrypted = encryptTeamKey(existingSameFingerprint.id);
    await ctx.db
      .update(cursorOrganisationApiKeys)
      .set({
        label,
        keyKind: input.keyKind,
        apiKeyEncrypted: encrypted,
        apiKeyHint: hint,
        identityLabel,
        createdByUserId: userId,
        lastValidatedAt: now,
        revokedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(cursorOrganisationApiKeys.id, existingSameFingerprint.id),
          eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
        ),
      );

    await ctx.db
      .update(cursorOrganisations)
      .set({ updatedAt: now })
      .where(eq(cursorOrganisations.id, input.cursorOrganisationId));

    return ok({
      id: existingSameFingerprint.id,
      cursorOrganisationId: input.cursorOrganisationId,
      label,
      keyKind: input.keyKind,
      apiKey,
      fingerprint,
      hint,
      identityLabel,
      createdByUserId: userId,
      lastValidatedAt: now,
      createdAt: existingSameFingerprint.createdAt,
    });
  }

  const id = newId();
  const encrypted = encryptTeamKey(id);
  try {
    await ctx.db.insert(cursorOrganisationApiKeys).values({
      id,
      cursorOrganisationId: input.cursorOrganisationId,
      orgId: ctx.orgId,
      label,
      keyKind: input.keyKind,
      apiKeyEncrypted: encrypted,
      apiKeyFingerprint: fingerprint,
      apiKeyHint: hint,
      identityLabel,
      createdByUserId: userId,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return err(
        coreError(
          'conflict',
          'That API key was just attached by another request. Refresh and try again.',
        ),
      );
    }
    throw error;
  }

  await ctx.db
    .update(cursorOrganisations)
    .set({ updatedAt: now })
    .where(eq(cursorOrganisations.id, input.cursorOrganisationId));

  return ok({
    id,
    cursorOrganisationId: input.cursorOrganisationId,
    label,
    keyKind: input.keyKind,
    apiKey,
    fingerprint,
    hint,
    identityLabel,
    createdByUserId: userId,
    lastValidatedAt: now,
    createdAt: now,
  });
}

export async function updateCursorOrganisationApiKey(
  ctx: ServiceContext,
  input: {
    apiKeyId: string;
    label?: string;
    keyKind?: CursorApiKeyKind;
    /** Pass plaintext to replace the secret; omit to keep the current key. */
    apiKey?: string;
    identityLabel?: string | null;
    /** When true, bump lastValidatedAt without changing the secret. */
    markValidated?: boolean;
  },
): Promise<Result<DecryptedCursorApiKey, CoreError>> {
  const human = requireHumanUserId(ctx);
  if (!human.ok) return human;

  const row = await ctx.db.query.cursorOrganisationApiKeys.findFirst({
    where: and(
      eq(cursorOrganisationApiKeys.id, input.apiKeyId),
      eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
    ),
  });
  if (!row || row.revokedAt) {
    return err(coreError('not_found', 'API key not found'));
  }
  if (!isOwnedBy(row.createdByUserId, human.value)) {
    return err(
      coreError(
        'forbidden',
        'Only the member who attached this API key can edit it',
      ),
    );
  }

  const keyKind = input.keyKind ?? row.keyKind;
  if (keyKind !== 'user' && keyKind !== 'service_account') {
    return err(coreError('validation', 'Key kind must be user or team.'));
  }

  const now = ctx.clock();
  const label = normalizeLabel(
    input.label ?? row.label,
    keyKind === 'service_account' ? 'Team API key' : 'User API key',
  );

  let apiKeyEncrypted = row.apiKeyEncrypted;
  let fingerprint = row.apiKeyFingerprint;
  let hint = row.apiKeyHint;
  let plaintext = decryptCursorApiKey(row.apiKeyEncrypted, {
    purpose: 'team-api-key',
    orgId: row.orgId,
    recordId: row.id,
  });
  let lastValidatedAt = row.lastValidatedAt;
  let identityLabel =
    input.identityLabel === undefined
      ? row.identityLabel
      : input.identityLabel?.trim() || null;

  const nextApiKey = input.apiKey?.trim();
  if (nextApiKey) {
    if (nextApiKey.length < 20) {
      return err(
        coreError(
          'validation',
          'Paste a Cursor User or Team API key (at least 20 characters).',
        ),
      );
    }
    fingerprint = fingerprintCursorApiKey(nextApiKey);
    const conflict = await ctx.db.query.cursorOrganisationApiKeys.findFirst({
      where: and(
        eq(
          cursorOrganisationApiKeys.cursorOrganisationId,
          row.cursorOrganisationId,
        ),
        eq(cursorOrganisationApiKeys.apiKeyFingerprint, fingerprint),
        isNull(cursorOrganisationApiKeys.revokedAt),
      ),
    });
    if (conflict && conflict.id !== row.id) {
      return err(
        coreError(
          'conflict',
          `That API key is already attached as “${conflict.label}”.`,
        ),
      );
    }
    apiKeyEncrypted = encryptCursorApiKey(nextApiKey, {
      purpose: 'team-api-key',
      orgId: row.orgId,
      recordId: row.id,
    });
    hint = maskCursorApiKey(nextApiKey);
    plaintext = nextApiKey;
    lastValidatedAt = now;
  } else if (input.markValidated) {
    lastValidatedAt = now;
  }

  await ctx.db
    .update(cursorOrganisationApiKeys)
    .set({
      label,
      keyKind,
      apiKeyEncrypted,
      apiKeyFingerprint: fingerprint,
      apiKeyHint: hint,
      identityLabel,
      lastValidatedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(cursorOrganisationApiKeys.id, row.id),
        eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
        eq(cursorOrganisationApiKeys.createdByUserId, human.value),
      ),
    );

  await ctx.db
    .update(cursorOrganisations)
    .set({ updatedAt: now })
    .where(eq(cursorOrganisations.id, row.cursorOrganisationId));

  return ok({
    id: row.id,
    cursorOrganisationId: row.cursorOrganisationId,
    label,
    keyKind,
    apiKey: plaintext,
    fingerprint,
    hint,
    identityLabel,
    createdByUserId: row.createdByUserId,
    lastValidatedAt,
    createdAt: row.createdAt,
  });
}

export async function revokeCursorOrganisationApiKey(
  ctx: ServiceContext,
  apiKeyId: string,
): Promise<Result<void, CoreError>> {
  const human = requireHumanUserId(ctx);
  if (!human.ok) return human;

  const row = await ctx.db.query.cursorOrganisationApiKeys.findFirst({
    where: and(
      eq(cursorOrganisationApiKeys.id, apiKeyId),
      eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
    ),
  });
  if (!row || row.revokedAt) {
    return err(coreError('not_found', 'API key not found'));
  }
  if (!isOwnedBy(row.createdByUserId, human.value)) {
    return err(
      coreError(
        'forbidden',
        'Only the member who attached this API key can revoke it',
      ),
    );
  }
  const now = ctx.clock();
  // Cryptographically erase the live secret on revoke. The fingerprint stays
  // for safe reattachment/dedup, while ciphertext no longer contains the key.
  const erasedCiphertext = encryptCursorApiKey('', {
    purpose: 'team-api-key',
    orgId: row.orgId,
    recordId: row.id,
  });
  await ctx.db
    .update(cursorOrganisationApiKeys)
    .set({
      apiKeyEncrypted: erasedCiphertext,
      revokedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(cursorOrganisationApiKeys.id, apiKeyId),
        eq(cursorOrganisationApiKeys.orgId, ctx.orgId),
        eq(cursorOrganisationApiKeys.createdByUserId, human.value),
      ),
    );
  return ok(undefined);
}

export async function listActiveCursorApiKeys(
  ctx: ServiceContext,
): Promise<
  Array<
    DecryptedCursorApiKey & {
      organisationId: string;
      organisationLabel: string;
      organizationId: string | null;
      baseUrl: string;
    }
  >
> {
  const orgs = await listCursorOrganisations(ctx);
  const out: Array<
    DecryptedCursorApiKey & {
      organisationId: string;
      organisationLabel: string;
      organizationId: string | null;
      baseUrl: string;
    }
  > = [];
  for (const org of orgs) {
    for (const key of org.apiKeys) {
      out.push({
        ...key,
        organisationId: org.id,
        organisationLabel: org.label,
        organizationId: org.organizationId,
        baseUrl: org.baseUrl,
      });
    }
  }
  return out;
}
