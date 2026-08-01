import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  defaultCursorApiBaseUrl,
  normalizeOrganizationId,
} from '@nexus/cursor-client';
import {
  fingerprintCursorApiKey,
  listCursorOrganisations,
  maskCursorApiKey,
  normalizeCursorBaseUrl,
  type CoreError,
  type DecryptedCursorOrganisation,
  type Result,
} from '@nexus/core';
import { currentUser } from './identity';
import { requireSession } from './session';

/** Legacy browser cookie (prototype BYOK). Prefer DB-backed organisations. */
export const CURSOR_ORGANISATIONS_COOKIE = 'nexus_cursor_organisations';
const LEGACY_API_KEYS_COOKIE = 'nexus_cursor_user_api_keys';
const LEGACY_API_KEY_COOKIE = 'nexus_cursor_user_api_key';

/** Legacy cookie max-age during the read-only transition window. */
export const LEGACY_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days
export const MAX_STORED_CURSOR_ORGS = 8;

export type StoredCursorApiKey = {
  id: string;
  label: string;
  keyKind: 'user' | 'service_account';
  apiKey: string;
  fingerprint: string;
  hint: string;
  identityLabel: string | null;
};

export type StoredCursorOrganisation = {
  /** Local connection id (not the Cursor org id). */
  id: string;
  /** Admin-chosen display name. */
  label: string;
  /** Public Cursor organization id (`org_…`), when known. */
  organizationId: string | null;
  /**
   * First Cloud Agents key (legacy shape). Prefer {@link apiKeys}.
   * Empty string when the organisation has no team keys yet.
   */
  apiKey: string;
  /** Optional Organization Admin API key (may differ from team keys). */
  orgApiKey: string | null;
  /** Cursor API base URL for this organisation. */
  baseUrl: string;
  /** All attached user / service-account Cloud Agents keys. */
  apiKeys: StoredCursorApiKey[];
  /** Where the connection was loaded from. */
  source: 'db' | 'cookie';
};

export type CursorOrganisationView = {
  id: string;
  label: string;
  organizationId: string | null;
  baseUrl: string;
  fingerprint: string | null;
  identity: string | null;
  hasOrgApiKey: boolean;
  orgApiKeyHint: string | null;
  apiKeyHint: string | null;
  canManage: boolean;
  canRemove: boolean;
  keys: Array<{
    id: string;
    label: string;
    keyKind: 'user' | 'service_account';
    fingerprint: string;
    hint: string;
    identityLabel: string | null;
    canRemove: boolean;
  }>;
  source: 'db' | 'cookie';
};

/** @deprecated Prefer fingerprintCursorApiKey from @nexus/core. */
export function fingerprintApiKey(apiKey: string): string {
  return fingerprintCursorApiKey(apiKey);
}

/** @deprecated Prefer maskCursorApiKey from @nexus/core. */
export function maskApiKey(apiKey: string): string {
  return maskCursorApiKey(apiKey);
}

export function normalizeBaseUrl(
  raw: string | null | undefined,
): Result<string, CoreError> {
  return normalizeCursorBaseUrl(raw);
}

function fromDbOrg(org: DecryptedCursorOrganisation): StoredCursorOrganisation {
  const apiKeys: StoredCursorApiKey[] = org.apiKeys.map((key) => ({
    id: key.id,
    label: key.label,
    keyKind: key.keyKind,
    apiKey: key.apiKey,
    fingerprint: key.fingerprint,
    hint: key.hint,
    identityLabel: key.identityLabel,
  }));
  return {
    id: org.id,
    label: org.label,
    organizationId: org.organizationId,
    apiKey: apiKeys[0]?.apiKey ?? '',
    orgApiKey: org.orgApiKey,
    baseUrl: org.baseUrl,
    apiKeys,
    source: 'db',
  };
}

function coerceApiKeys(
  row: Record<string, unknown>,
): StoredCursorApiKey[] | null {
  if (Array.isArray(row.apiKeys)) {
    const keys: StoredCursorApiKey[] = [];
    for (const raw of row.apiKeys) {
      if (!raw || typeof raw !== 'object') return null;
      const key = raw as Record<string, unknown>;
      if (
        typeof key.id !== 'string' ||
        typeof key.label !== 'string' ||
        (key.keyKind !== 'user' && key.keyKind !== 'service_account') ||
        typeof key.apiKey !== 'string' ||
        key.apiKey.trim().length < 20
      ) {
        return null;
      }
      const apiKey = key.apiKey.trim();
      keys.push({
        id: key.id,
        label: key.label,
        keyKind: key.keyKind,
        apiKey,
        fingerprint:
          typeof key.fingerprint === 'string'
            ? key.fingerprint
            : fingerprintCursorApiKey(apiKey),
        hint:
          typeof key.hint === 'string' ? key.hint : maskCursorApiKey(apiKey),
        identityLabel:
          typeof key.identityLabel === 'string' ? key.identityLabel : null,
      });
    }
    return keys;
  }

  if (typeof row.apiKey === 'string' && row.apiKey.trim().length >= 20) {
    const apiKey = row.apiKey.trim();
    return [
      {
        id:
          typeof row.id === 'string'
            ? `${row.id}:primary`
            : fingerprintCursorApiKey(apiKey),
        label: 'Primary',
        keyKind: 'user',
        apiKey,
        fingerprint: fingerprintCursorApiKey(apiKey),
        hint: maskCursorApiKey(apiKey),
        identityLabel: null,
      },
    ];
  }
  return [];
}

export function isStoredCursorOrganisation(
  value: unknown,
): value is StoredCursorOrganisation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.label !== 'string' ||
    (row.organizationId !== null &&
      row.organizationId !== undefined &&
      typeof row.organizationId !== 'string') ||
    (row.orgApiKey !== null &&
      row.orgApiKey !== undefined &&
      typeof row.orgApiKey !== 'string') ||
    typeof row.baseUrl !== 'string'
  ) {
    return false;
  }
  const keys = coerceApiKeys(row);
  return keys !== null;
}

function normalizeStoredRow(
  value: unknown,
  source: 'db' | 'cookie',
): StoredCursorOrganisation | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.baseUrl !== 'string'
  ) {
    return null;
  }
  const apiKeys = coerceApiKeys(row);
  if (apiKeys === null) return null;
  const baseUrlResult = normalizeBaseUrl(row.baseUrl);
  if (!baseUrlResult.ok) return null;
  return {
    id: row.id,
    label: row.label.trim() || 'Organisation',
    organizationId: normalizeOrganizationId(
      typeof row.organizationId === 'string' ? row.organizationId : null,
    ),
    apiKey: apiKeys[0]?.apiKey ?? '',
    orgApiKey:
      typeof row.orgApiKey === 'string' && row.orgApiKey.trim().length >= 20
        ? row.orgApiKey.trim()
        : null,
    baseUrl: baseUrlResult.value,
    apiKeys,
    source,
  };
}

async function readLegacyApiKeys(): Promise<string[]> {
  const store = await cookies();
  const multi = store.get(LEGACY_API_KEYS_COOKIE)?.value?.trim();
  if (multi) {
    try {
      const parsed = JSON.parse(multi) as unknown;
      if (Array.isArray(parsed)) {
        return [
          ...new Set(
            parsed
              .map((k) => (typeof k === 'string' ? k.trim() : ''))
              .filter((k) => k.length >= 20),
          ),
        ].slice(0, MAX_STORED_CURSOR_ORGS);
      }
    } catch {
      // fall through
    }
  }
  const legacy = store.get(LEGACY_API_KEY_COOKIE)?.value?.trim();
  return legacy ? [legacy] : [];
}

export function migrateKeysToOrganisations(
  keys: string[],
): StoredCursorOrganisation[] {
  return keys.map((apiKey, index) => {
    const fingerprint = fingerprintCursorApiKey(apiKey);
    return {
      id: fingerprint,
      label:
        keys.length === 1
          ? 'Connected organisation'
          : `Organisation ${index + 1}`,
      organizationId: null,
      apiKey,
      orgApiKey: null,
      baseUrl: defaultCursorApiBaseUrl(),
      apiKeys: [
        {
          id: `${fingerprint}:primary`,
          label: 'Primary',
          keyKind: 'user',
          apiKey,
          fingerprint,
          hint: maskCursorApiKey(apiKey),
          identityLabel: null,
        },
      ],
      source: 'cookie' as const,
    };
  });
}

async function readCookieOrganisations(): Promise<StoredCursorOrganisation[]> {
  const store = await cookies();
  const raw = store.get(CURSOR_ORGANISATIONS_COOKIE)?.value?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((row) => normalizeStoredRow(row, 'cookie'))
          .filter((row): row is StoredCursorOrganisation => row !== null)
          .slice(0, MAX_STORED_CURSOR_ORGS);
      }
    } catch {
      // fall through to legacy keys
    }
  }

  const legacyKeys = await readLegacyApiKeys();
  return migrateKeysToOrganisations(legacyKeys);
}

/**
 * Read Cursor organisation connections.
 * Prefer encrypted DB rows for the signed-in Nexus org; fall back to the
 * legacy httpOnly cookie (read-only, 14-day transition) only when:
 * - there is no current user, or
 * - an authenticated DB read succeeds and returns zero rows.
 * DB/session failures with a current user fail closed (never cookie fallback).
 */
export async function readCursorOrganisations(): Promise<
  StoredCursorOrganisation[]
> {
  const user = await currentUser();
  if (user) {
    const session = await requireSession();
    const fromDb = await listCursorOrganisations(session.ctx);
    if (fromDb.length > 0) {
      return fromDb.map(fromDbOrg);
    }
  }
  return readCookieOrganisations();
}

/**
 * Delete legacy organisation cookies. Does not write plaintext secrets —
 * cookie storage is read-only during the transition window.
 */
export async function clearCursorOrganisations(): Promise<void> {
  const store = await cookies();
  store.delete(CURSOR_ORGANISATIONS_COOKIE);
  store.delete(LEGACY_API_KEYS_COOKIE);
  store.delete(LEGACY_API_KEY_COOKIE);
}

/** Stable fingerprint spanning all team keys on a connection. */
export function organisationCredentialFingerprint(
  org: Pick<StoredCursorOrganisation, 'apiKeys' | 'apiKey'>,
): string {
  const fps = (
    org.apiKeys.length > 0
      ? org.apiKeys.map((k) => k.fingerprint)
      : org.apiKey
        ? [fingerprintCursorApiKey(org.apiKey)]
        : []
  ).sort();
  if (fps.length === 0) return '';
  if (fps.length === 1) return fps[0]!;
  return createHash('sha256').update(fps.join('|')).digest('hex').slice(0, 24);
}
