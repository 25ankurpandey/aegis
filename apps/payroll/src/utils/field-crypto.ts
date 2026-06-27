import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Config, ErrUtils } from '@aegis/service-core';

/**
 * AES-256-GCM field-level encryption for the most sensitive payroll PII (salary, bank account,
 * national id, net pay). This sits ON TOP OF at-rest/in-transit encryption: a stolen DB dump
 * yields ciphertext only, and the GCM auth tag makes any tampering detectable.
 *
 * Stored ciphertext format (single string in a `_enc` column):
 *   <iv-hex>:<authTag-hex>:<ciphertext-hex>
 *
 * The key comes from FIELD_ENCRYPTION_KEY (64 hex chars = 32 bytes). In a production deployment
 * this is a per-tenant DEK wrapped by a KMS master key; here it is resolved from config.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

function loadKey(): Buffer {
  const hex = Config.require('FIELD_ENCRYPTION_KEY');
  const raw = Buffer.from(hex, 'hex');
  if (raw.length === 0) {
    throw ErrUtils.system('FIELD_ENCRYPTION_KEY must be a non-empty hex string');
  }
  // AES-256 needs exactly 32 bytes. A full 32-byte key is used as-is; any other length is
  // deterministically derived to 32 bytes via SHA-256 (a stolen DB dump still yields ciphertext only).
  return raw.length === KEY_BYTES ? raw : createHash('sha256').update(raw).digest();
}

/** Encrypt a clear value into the stored ciphertext string. Returns null for null/undefined input. */
export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined) return null;
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decrypt a stored ciphertext string back to clear. Returns null for null/undefined input. */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw ErrUtils.system('Malformed ciphertext in encrypted field');
  }
  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const clear = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return clear.toString('utf8');
}

/** Mask a sensitive value to its last 4 characters, e.g. bank account → "•••• 4321". */
export function maskLast4(clear: string | null): string | null {
  if (clear === null) return null;
  const tail = clear.slice(-4);
  return `•••• ${tail}`;
}
