import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEV_FALLBACK_KEY = 'dev-only-webhook-encryption-key-32b';
const ACTIVE_KEY_ID = 'k1';

function resolveEncryptionMaterial(keyId: string): Buffer {
  const envKey =
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? process.env.MCP_TOKEN_SIGNING_KEY;
  if (!envKey) {
    const isProd =
      process.env.NODE_ENV === 'production' ||
      process.env.VERCEL === '1' ||
      process.env.VERCEL_ENV === 'production';
    if (isProd) {
      throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY is required in production');
    }
    if (keyId !== ACTIVE_KEY_ID) {
      throw new Error(`Unknown webhook encryption key id: ${keyId}`);
    }
    return createHash('sha256').update(DEV_FALLBACK_KEY, 'utf8').digest();
  }
  if (keyId !== ACTIVE_KEY_ID) {
    throw new Error(`Unknown webhook encryption key id: ${keyId}`);
  }
  return createHash('sha256').update(envKey, 'utf8').digest();
}

function encryptBlob(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptBlob(key: Buffer, blob: string): string {
  const buf = Buffer.from(blob, 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptWebhookSecret(plaintext: string): string {
  const key = resolveEncryptionMaterial(ACTIVE_KEY_ID);
  return `${ACTIVE_KEY_ID}:${encryptBlob(key, plaintext)}`;
}

export function decryptWebhookSecret(ciphertext: string): string {
  if (ciphertext.includes(':')) {
    const idx = ciphertext.indexOf(':');
    const keyId = ciphertext.slice(0, idx);
    const blob = ciphertext.slice(idx + 1);
    const key = resolveEncryptionMaterial(keyId);
    return decryptBlob(key, blob);
  }
  const key = resolveEncryptionMaterial(ACTIVE_KEY_ID);
  return decryptBlob(key, ciphertext);
}
