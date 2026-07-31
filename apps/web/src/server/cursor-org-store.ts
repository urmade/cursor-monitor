import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  defaultCursorApiBaseUrl,
  normalizeOrganizationId,
} from '@nexus/cursor-client';

/** Structured multi-org Cursor connections (httpOnly cookie). */
export const CURSOR_ORGANISATIONS_COOKIE = 'nexus_cursor_organisations';
/** Kept in sync for older Monitoring readers. */
const LEGACY_API_KEYS_COOKIE = 'nexus_cursor_user_api_keys';
const LEGACY_API_KEY_COOKIE = 'nexus_cursor_user_api_key';

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days
export const MAX_STORED_CURSOR_ORGS = 8;

export type StoredCursorOrganisation = {
  /** Local connection id (not the Cursor org id). */
  id: string;
  /** Admin-chosen display name. */
  label: string;
  /** Public Cursor organization id (`org_…`), when known. */
  organizationId: string | null;
  /** Cloud Agents / user / service-account API key used for Monitoring. */
  apiKey: string;
  /** Optional Organization Admin API key (may differ from apiKey). */
  orgApiKey: string | null;
  /** Cursor API base URL for this organisation. */
  baseUrl: string;
};

export type CursorOrganisationView = {
  id: string;
  label: string;
  organizationId: string | null;
  baseUrl: string;
  fingerprint: string;
  identity: string | null;
  hasOrgApiKey: boolean;
  apiKeyHint: string;
};

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SEC,
  };
}

export function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return '••••';
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function normalizeBaseUrl(raw: string | null | undefined): string {
  const fallback = defaultCursorApiBaseUrl();
  const value = (raw?.trim() || fallback).replace(/\/$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export function isStoredCursorOrganisation(
  value: unknown,
): value is StoredCursorOrganisation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.label === 'string' &&
    (row.organizationId === null || typeof row.organizationId === 'string') &&
    typeof row.apiKey === 'string' &&
    (row.orgApiKey === null || typeof row.orgApiKey === 'string') &&
    typeof row.baseUrl === 'string'
  );
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
  return keys.map((apiKey, index) => ({
    id: fingerprintApiKey(apiKey),
    label:
      keys.length === 1 ? 'Connected organisation' : `Organisation ${index + 1}`,
    organizationId: null,
    apiKey,
    orgApiKey: null,
    baseUrl: defaultCursorApiBaseUrl(),
  }));
}

/** Read stored Cursor organisation connections (migrates legacy key cookies). */
export async function readCursorOrganisations(): Promise<
  StoredCursorOrganisation[]
> {
  const store = await cookies();
  const raw = store.get(CURSOR_ORGANISATIONS_COOKIE)?.value?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter(isStoredCursorOrganisation)
          .map((row) => ({
            ...row,
            label: row.label.trim() || 'Organisation',
            organizationId: normalizeOrganizationId(row.organizationId),
            apiKey: row.apiKey.trim(),
            orgApiKey: row.orgApiKey?.trim() ? row.orgApiKey.trim() : null,
            baseUrl: normalizeBaseUrl(row.baseUrl),
          }))
          .filter((row) => row.apiKey.length >= 20)
          .slice(0, MAX_STORED_CURSOR_ORGS);
      }
    } catch {
      // fall through to legacy keys
    }
  }

  const legacyKeys = await readLegacyApiKeys();
  return migrateKeysToOrganisations(legacyKeys);
}

export async function writeCursorOrganisations(
  orgs: StoredCursorOrganisation[],
): Promise<void> {
  const store = await cookies();
  const unique = orgs
    .map((row) => ({
      ...row,
      label: row.label.trim() || 'Organisation',
      organizationId: normalizeOrganizationId(row.organizationId),
      apiKey: row.apiKey.trim(),
      orgApiKey: row.orgApiKey?.trim() ? row.orgApiKey.trim() : null,
      baseUrl: normalizeBaseUrl(row.baseUrl),
    }))
    .filter((row) => row.apiKey.length >= 20)
    .slice(0, MAX_STORED_CURSOR_ORGS);

  const opts = cookieOptions();
  if (unique.length === 0) {
    store.delete(CURSOR_ORGANISATIONS_COOKIE);
    store.delete(LEGACY_API_KEYS_COOKIE);
    store.delete(LEGACY_API_KEY_COOKIE);
    return;
  }

  store.set(CURSOR_ORGANISATIONS_COOKIE, JSON.stringify(unique), opts);
  // Keep legacy multi-key cookies in sync for older readers.
  const keys = unique.map((row) => row.apiKey);
  store.set(LEGACY_API_KEYS_COOKIE, JSON.stringify(keys), opts);
  store.set(LEGACY_API_KEY_COOKIE, keys[0]!, opts);
}

export async function clearCursorOrganisations(): Promise<void> {
  await writeCursorOrganisations([]);
}
