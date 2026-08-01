import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const DEV_FALLBACK_IKM = 'dev-only-cursor-credentials-key-32b';

/**
 * Ciphertext key-id for the HKDF-derived AES-GCM scheme with context-bound AAD.
 * Earlier branch-local `k1` blobs used plain SHA-256 of the IKM and no AAD;
 * this branch is unmerged so those are intentionally not decryptable.
 */
const ACTIVE_KEY_ID = 'k2';

/** HKDF salt — domain-separates Cursor credential keys from other Nexus secrets. */
const HKDF_SALT = Buffer.from('nexus/cursor-credentials/hkdf-salt/v1', 'utf8');

/** HKDF info — binds the derived key to AES-256-GCM for Cursor API keys. */
const HKDF_INFO = Buffer.from(
  'nexus/cursor-credentials/aes-256-gcm/v1',
  'utf8',
);

/**
 * Fixed protocol domain for AES-GCM AAD. Combined with purpose / org / record
 * so ciphertexts cannot be swapped across rows, tenants, or secret kinds.
 */
const GCM_AAD_DOMAIN = 'nexus/cursor-credentials/aad/v1';

/** Unit separator — forbidden inside context components to keep AAD unambiguous. */
const AAD_SEPARATOR = '\u001f';

export const CURSOR_SECRET_PURPOSES = [
  'team-api-key',
  'org-admin-api-key',
  'cost-credentials',
] as const;

export type CursorSecretPurpose = (typeof CURSOR_SECRET_PURPOSES)[number];

/**
 * Binding context required for every encrypt/decrypt.
 * `recordId` is the stable row id (DB) or KV store key (cost envelope).
 */
export type CursorSecretContext = {
  purpose: CursorSecretPurpose;
  /** Nexus organisation id (tenant). */
  orgId: string;
  /** Stable record / store identifier for this ciphertext. */
  recordId: string;
};

function isCursorSecretPurpose(value: string): value is CursorSecretPurpose {
  return (CURSOR_SECRET_PURPOSES as readonly string[]).includes(value);
}

/**
 * Reject empty components and those containing the AAD separator so encoded
 * AAD cannot be ambiguous under delimiter splitting.
 */
function assertSafeAadComponent(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Cursor secret context ${name} is required`);
  }
  if (trimmed !== value) {
    throw new Error(
      `Cursor secret context ${name} must not have leading or trailing whitespace`,
    );
  }
  if (trimmed.includes(AAD_SEPARATOR)) {
    throw new Error(
      `Cursor secret context ${name} must not contain the AAD separator`,
    );
  }
  return trimmed;
}

/** Build unambiguous AES-GCM AAD: domain ‖ purpose ‖ orgId ‖ recordId. */
export function buildCursorSecretAad(context: CursorSecretContext): Buffer {
  if (!isCursorSecretPurpose(context.purpose)) {
    throw new Error(`Unknown cursor secret purpose: ${String(context.purpose)}`);
  }
  const purpose = assertSafeAadComponent('purpose', context.purpose);
  const orgId = assertSafeAadComponent('orgId', context.orgId);
  const recordId = assertSafeAadComponent('recordId', context.recordId);
  return Buffer.from(
    [GCM_AAD_DOMAIN, purpose, orgId, recordId].join(AAD_SEPARATOR),
    'utf8',
  );
}

/**
 * Resolve input keying material for Cursor API keys stored at rest.
 *
 * Prefer a dedicated `CURSOR_CREDENTIALS_ENCRYPTION_KEY`. Fall back to the
 * existing MCP / webhook signing material so deploys that already set those
 * work without an extra secret. Never use a hard-coded IKM in production.
 */
function resolveInputKeyMaterial(keyId: string): Buffer {
  const envKey =
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY?.trim() ||
    process.env.MCP_TOKEN_SIGNING_KEY?.trim() ||
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY?.trim() ||
    '';
  if (!envKey) {
    const isProd =
      process.env.NODE_ENV === 'production' ||
      process.env.VERCEL === '1' ||
      process.env.VERCEL_ENV === 'production';
    if (isProd) {
      throw new Error(
        'CURSOR_CREDENTIALS_ENCRYPTION_KEY (or MCP_TOKEN_SIGNING_KEY) is required in production',
      );
    }
    if (keyId !== ACTIVE_KEY_ID) {
      throw new Error(`Unknown cursor credentials encryption key id: ${keyId}`);
    }
    return Buffer.from(DEV_FALLBACK_IKM, 'utf8');
  }
  if (keyId !== ACTIVE_KEY_ID) {
    throw new Error(`Unknown cursor credentials encryption key id: ${keyId}`);
  }
  return Buffer.from(envKey, 'utf8');
}

/**
 * Derive a dedicated 32-byte AES key via HKDF-SHA256 so reuse of signing-key
 * IKM cannot produce a key interchangeable with other protocols.
 */
function deriveEncryptionKey(ikm: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, 32));
}

function resolveEncryptionKey(keyId: string): Buffer {
  return deriveEncryptionKey(resolveInputKeyMaterial(keyId));
}

function encryptBlob(
  key: Buffer,
  plaintext: string,
  aad: Buffer,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptBlob(key: Buffer, blob: string, aad: Buffer): string {
  const buf = Buffer.from(blob, 'base64url');
  if (buf.length < 28) {
    throw new Error('Invalid cursor credentials ciphertext');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Encrypt a Cursor API key for database / KV storage.
 * Format: `k2:<base64url(iv ‖ tag ‖ ciphertext)>` (AES-256-GCM + context AAD).
 */
export function encryptCursorApiKey(
  plaintext: string,
  context: CursorSecretContext,
): string {
  const aad = buildCursorSecretAad(context);
  const key = resolveEncryptionKey(ACTIVE_KEY_ID);
  return `${ACTIVE_KEY_ID}:${encryptBlob(key, plaintext, aad)}`;
}

/** Decrypt a Cursor API key previously stored with {@link encryptCursorApiKey}. */
export function decryptCursorApiKey(
  ciphertext: string,
  context: CursorSecretContext,
): string {
  const idx = ciphertext.indexOf(':');
  if (idx <= 0) {
    throw new Error('Invalid cursor credentials ciphertext: missing key id');
  }
  const keyId = ciphertext.slice(0, idx);
  const blob = ciphertext.slice(idx + 1);
  const aad = buildCursorSecretAad(context);
  const key = resolveEncryptionKey(keyId);
  return decryptBlob(key, blob, aad);
}

/** Stable short fingerprint for dedup / cache keys (not a secret). */
export function fingerprintCursorApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 24);
}

/** Masked display form — safe to show in the UI. */
export function maskCursorApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return '••••';
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}
