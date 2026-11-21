import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

export interface SealedToken {
  ciphertext: string;
  keyId: string;
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope encryption for Gmail refresh tokens (TRD 8.3): a fresh AES-256-GCM data key per token,
 * the data key wrapped by the KeyProvider. `context` (for example the inbox id) is authenticated
 * but not stored, so a ciphertext copied onto another row fails to open.
 */
export class TokenVault {
  constructor(private readonly keys: KeyProvider) {}

  async seal(plaintext: string, context: string): Promise<SealedToken> {
    const dataKey = randomBytes(32);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
    const wrapped = await this.keys.wrap(dataKey);
    dataKey.fill(0);
    return { ciphertext: `${VERSION}.${wrapped}.${payload}`, keyId: this.keys.keyId };
  }

  async open(sealed: SealedToken, context: string): Promise<string> {
    const [version, wrapped, payload, extra] = sealed.ciphertext.split('.');
    if (version !== VERSION || !wrapped || !payload || extra !== undefined) throw new Error('unsupported token format');
    const dataKey = await this.keys.unwrap(wrapped, sealed.keyId);
    try {
      const raw = Buffer.from(payload, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', dataKey, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString(
        'utf8',
      );
    } finally {
      dataKey.fill(0);
    }
  }

  /** True when the row was sealed under an older master key and should be re-sealed. */
  needsRotation(sealed: SealedToken): boolean {
    return sealed.keyId !== this.keys.keyId;
  }
}
