import {
  createDecipheriv,
  createHash,
  hkdfSync,
} from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCursorSecretAad,
  decryptCursorApiKey,
  encryptCursorApiKey,
  fingerprintCursorApiKey,
  maskCursorApiKey,
  type CursorSecretContext,
} from './secret-crypto';

const CTX: CursorSecretContext = {
  purpose: 'team-api-key',
  orgId: 'nexus-org-1',
  recordId: 'api-key-row-1',
};

describe('cursor credentials secret-crypto', () => {
  const prev = {
    CURSOR_CREDENTIALS_ENCRYPTION_KEY: process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY,
    MCP_TOKEN_SIGNING_KEY: process.env.MCP_TOKEN_SIGNING_KEY,
    WEBHOOK_SECRET_ENCRYPTION_KEY: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('round-trips with a dedicated encryption key (k2 + HKDF + context AAD)', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    delete process.env.MCP_TOKEN_SIGNING_KEY;
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;

    const plaintext = 'cursor_abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptCursorApiKey(plaintext, CTX);
    expect(encrypted.startsWith('k2:')).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptCursorApiKey(encrypted, CTX)).toBe(plaintext);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    const a = encryptCursorApiKey('cursor_same_key_value_123456', CTX);
    const b = encryptCursorApiKey('cursor_same_key_value_123456', CTX);
    expect(a).not.toBe(b);
    expect(decryptCursorApiKey(a, CTX)).toBe(decryptCursorApiKey(b, CTX));
  });

  it('rejects tampered ciphertext', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    const colon = encrypted.indexOf(':');
    const keyId = encrypted.slice(0, colon);
    const blob = encrypted.slice(colon + 1);
    const buf = Buffer.from(blob, 'base64url');
    const last = buf.length - 1;
    buf[last] = (buf[last] ?? 0) ^ 0xff;
    const tampered = `${keyId}:${buf.toString('base64url')}`;
    expect(() => decryptCursorApiKey(tampered, CTX)).toThrow();
  });

  it('rejects decrypt under a different encryption key', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key-a';
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key-b';
    expect(() => decryptCursorApiKey(encrypted, CTX)).toThrow();
  });

  it('fails auth when decrypted under a different org id', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    expect(() =>
      decryptCursorApiKey(encrypted, { ...CTX, orgId: 'nexus-org-other' }),
    ).toThrow();
  });

  it('fails auth when decrypted under a different record id', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    expect(() =>
      decryptCursorApiKey(encrypted, { ...CTX, recordId: 'api-key-row-2' }),
    ).toThrow();
  });

  it('fails auth when decrypted under a different purpose', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    expect(() =>
      decryptCursorApiKey(encrypted, {
        ...CTX,
        purpose: 'org-admin-api-key',
      }),
    ).toThrow();
    expect(() =>
      decryptCursorApiKey(encrypted, {
        ...CTX,
        purpose: 'cost-credentials',
      }),
    ).toThrow();
  });

  it('rejects context components that would make AAD ambiguous', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    expect(() =>
      encryptCursorApiKey('cursor_abcdefghijklmnopqrstuvwxyz', {
        ...CTX,
        orgId: `bad${'\u001f'}org`,
      }),
    ).toThrow(/AAD separator/);
    expect(() =>
      buildCursorSecretAad({ ...CTX, recordId: '' }),
    ).toThrow(/recordId is required/);
    expect(() =>
      buildCursorSecretAad({
        ...CTX,
        purpose: 'not-a-purpose' as CursorSecretContext['purpose'],
      }),
    ).toThrow(/Unknown cursor secret purpose/);
  });

  it('does not decrypt under the legacy SHA-256 key (domain separation)', () => {
    const ikm = 'shared-signing-material-for-domain-test';
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = ikm;
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    const blob = encrypted.slice('k2:'.length);
    const buf = Buffer.from(blob, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);

    // Legacy scheme: AES key = SHA-256(IKM), no AAD.
    const legacyKey = createHash('sha256').update(ikm, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-gcm', legacyKey, iv);
    decipher.setAuthTag(tag);
    expect(() =>
      Buffer.concat([decipher.update(data), decipher.final()]),
    ).toThrow();
  });

  it('fails auth when AAD is omitted on an otherwise valid blob', () => {
    const ikm = 'test-cursor-creds-key';
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = ikm;
    const encrypted = encryptCursorApiKey(
      'cursor_abcdefghijklmnopqrstuvwxyz',
      CTX,
    );
    const blob = encrypted.slice('k2:'.length);
    const buf = Buffer.from(blob, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);

    // Reconstruct the HKDF-derived key with the same fixed domain strings.
    const derivedKey = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(ikm, 'utf8'),
        Buffer.from('nexus/cursor-credentials/hkdf-salt/v1', 'utf8'),
        Buffer.from('nexus/cursor-credentials/aes-256-gcm/v1', 'utf8'),
        32,
      ),
    );
    const noAad = createDecipheriv('aes-256-gcm', derivedKey, iv);
    noAad.setAuthTag(tag);
    expect(() => Buffer.concat([noAad.update(data), noAad.final()])).toThrow();

    // Fixed protocol domain alone (pre-context AAD) must also fail.
    const fixedOnly = createDecipheriv('aes-256-gcm', derivedKey, iv);
    fixedOnly.setAAD(Buffer.from('nexus/cursor-credentials/aad/v1', 'utf8'));
    fixedOnly.setAuthTag(tag);
    expect(() =>
      Buffer.concat([fixedOnly.update(data), fixedOnly.final()]),
    ).toThrow();
  });

  it('rejects unknown key ids and unversioned blobs', () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'test-cursor-creds-key';
    expect(() => decryptCursorApiKey('k1:not-a-real-blob', CTX)).toThrow(
      /Unknown cursor credentials encryption key id/,
    );
    expect(() => decryptCursorApiKey('no-prefix-blob', CTX)).toThrow(
      /missing key id/,
    );
  });

  it('fingerprints and masks without leaking the full key', () => {
    const key = 'cursor_abcdefghijklmnopqrstuvwxyz';
    expect(fingerprintCursorApiKey(key)).toHaveLength(24);
    expect(maskCursorApiKey(key)).toBe('cursor…wxyz');
    expect(maskCursorApiKey(key)).not.toBe(key);
  });

  it('rejects production without an encryption key', () => {
    delete process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.MCP_TOKEN_SIGNING_KEY;
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    expect(() =>
      encryptCursorApiKey('cursor_abcdefghijklmnopqrstuvwxyz', CTX),
    ).toThrow(/CURSOR_CREDENTIALS_ENCRYPTION_KEY/);
  });
});
