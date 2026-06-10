import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function buildCrypto(encryptionKey: string): {
  encrypt: (plaintext: string) => Promise<string>;
  decrypt: (ciphertext: string) => Promise<string>;
} {
  const keyBuf = Buffer.from(encryptionKey, 'base64');
  if (keyBuf.length !== 32) {
    throw new Error('encryptionKey must be a base64-encoded 32-byte key');
  }

  async function encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // format: iv (12) || tag (16) || ciphertext — all base64
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  async function decrypt(ciphertext: string): Promise<string> {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  return { encrypt, decrypt };
}
