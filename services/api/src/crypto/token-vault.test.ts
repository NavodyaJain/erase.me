import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalKeyProvider } from './key-provider.js';
import { TokenVault } from './token-vault.js';

const newKey = () => randomBytes(32).toString('base64');

describe('TokenVault', () => {
  it('round-trips and never stores the plaintext', async () => {
    const vault = new TokenVault(new LocalKeyProvider(newKey()));
    const sealed = await vault.seal('refresh-token-value', 'inb_1');
    expect(sealed.ciphertext).not.toContain('refresh-token-value');
    expect(await vault.open(sealed, 'inb_1')).toBe('refresh-token-value');
  });

  it('uses a fresh data key and iv each time', async () => {
    const vault = new TokenVault(new LocalKeyProvider(newKey()));
    const a = await vault.seal('same', 'inb_1');
    const b = await vault.seal('same', 'inb_1');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses a ciphertext moved to another row (context mismatch) or tampered with', async () => {
    const vault = new TokenVault(new LocalKeyProvider(newKey()));
    const sealed = await vault.seal('secret', 'inb_1');
    await expect(vault.open(sealed, 'inb_2')).rejects.toThrow();
    // Flip a character in the middle of the encrypted payload (the last character can be padding bits).
    const i = sealed.ciphertext.length - 20;
    const flipped = sealed.ciphertext[i] === 'A' ? 'B' : 'A';
    const tampered = sealed.ciphertext.slice(0, i) + flipped + sealed.ciphertext.slice(i + 1);
    await expect(vault.open({ ...sealed, ciphertext: tampered }, 'inb_1')).rejects.toThrow();
  });

  it('rotates: old rows open with a retired key, new rows use the current key', async () => {
    const oldKey = newKey();
    const sealed = await new TokenVault(new LocalKeyProvider(oldKey)).seal('secret', 'inb_1');
    const rotated = new TokenVault(new LocalKeyProvider(newKey(), [oldKey]));
    expect(rotated.needsRotation(sealed)).toBe(true);
    expect(await rotated.open(sealed, 'inb_1')).toBe('secret');
    const resealed = await rotated.seal('secret', 'inb_1');
    expect(rotated.needsRotation(resealed)).toBe(false);
    expect(resealed.keyId).not.toBe(sealed.keyId);
  });

  it('cannot open under a different master key', async () => {
    const sealed = await new TokenVault(new LocalKeyProvider(newKey())).seal('secret', 'inb_1');
    await expect(new TokenVault(new LocalKeyProvider(newKey())).open(sealed, 'inb_1')).rejects.toThrow();
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => new LocalKeyProvider(randomBytes(16).toString('base64'))).toThrow();
  });
});
