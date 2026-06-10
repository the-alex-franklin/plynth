import { buildCrypto } from '../src/crypto';
import { randomBytes } from 'crypto';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

describe('buildCrypto', () => {
  it('throws on a key that is not 32 bytes when decoded', () => {
    expect(() => buildCrypto(Buffer.from('tooshort').toString('base64'))).toThrow();
  });

  it('throws on a non-base64 string', () => {
    expect(() => buildCrypto('not-valid-base64!!!')).toThrow();
  });

  it('roundtrips plaintext', async () => {
    const { encrypt, decrypt } = buildCrypto(makeKey());
    const plaintext = 'access-sandbox-abc123';
    expect(await decrypt(await encrypt(plaintext))).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', async () => {
    const { encrypt } = buildCrypto(makeKey());
    const a = await encrypt('same');
    const b = await encrypt('same');
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with a different key', async () => {
    const { encrypt } = buildCrypto(makeKey());
    const { decrypt } = buildCrypto(makeKey());
    const ciphertext = await encrypt('secret');
    await expect(decrypt(ciphertext)).rejects.toThrow();
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const { encrypt, decrypt } = buildCrypto(makeKey());
    const ciphertext = await encrypt('secret');
    const buf = Buffer.from(ciphertext, 'base64');
    buf[buf.length - 1] ^= 0xff;
    await expect(decrypt(buf.toString('base64'))).rejects.toThrow();
  });
});
