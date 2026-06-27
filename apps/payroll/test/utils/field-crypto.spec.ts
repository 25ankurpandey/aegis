// A 32-byte (64 hex char) key must be present before the field-crypto module resolves it.
process.env['FIELD_ENCRYPTION_KEY'] =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { encryptField, decryptField, maskLast4 } from '../../src/utils/field-crypto';

describe('field-crypto (AES-256-GCM field encryption)', () => {
  describe('encryptField / decryptField', () => {
    it('round-trips a clear value', () => {
      const cipher = encryptField('1234567890');
      expect(cipher).not.toBeNull();
      expect(cipher).not.toBe('1234567890'); // never stored in clear
      expect(decryptField(cipher)).toBe('1234567890');
    });

    it('produces a different ciphertext each time (random IV)', () => {
      expect(encryptField('same')).not.toEqual(encryptField('same'));
    });

    it('stores ciphertext as iv:authTag:data hex triplets', () => {
      const cipher = encryptField('secret');
      expect(cipher).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    });

    it('returns null for null/undefined input', () => {
      expect(encryptField(null)).toBeNull();
      expect(encryptField(undefined)).toBeNull();
      expect(decryptField(null)).toBeNull();
      expect(decryptField(undefined)).toBeNull();
    });

    it('throws on malformed stored ciphertext', () => {
      expect(() => decryptField('not-a-valid-ciphertext')).toThrow();
    });

    it('rejects tampered ciphertext via the GCM auth tag', () => {
      const cipher = encryptField('do-not-tamper')!;
      const [iv, tag, data] = cipher.split(':');
      // Flip the last data nibble so the auth tag no longer verifies.
      const flipped = data.slice(0, -1) + (data.slice(-1) === '0' ? '1' : '0');
      expect(() => decryptField(`${iv}:${tag}:${flipped}`)).toThrow();
    });
  });

  describe('maskLast4', () => {
    it('masks all but the last four characters', () => {
      expect(maskLast4('1234567890')).toBe('•••• 7890');
    });

    it('returns null for null input', () => {
      expect(maskLast4(null)).toBeNull();
    });
  });
});
