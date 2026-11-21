import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Wraps and unwraps data keys with a master key that never leaves the provider (TRD 8.3).
 * The local provider reads the key from the environment. A KMS-backed provider replaces it by
 * implementing this interface; nothing else in the codebase touches the master key.
 */
export interface KeyProvider {
  /** Identifies the master key. Stored beside every ciphertext so old rows stay readable after rotation. */
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<string>;
  /** `keyId` is the id stored with the ciphertext. Throws if this provider does not hold that key. */
  unwrap(wrapped: string, keyId: string): Promise<Buffer>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM key wrapping with a 32-byte master key from TOKEN_MASTER_KEY (base64). */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  private readonly keys = new Map<string, Buffer>();
  private readonly current: Buffer;

  /**
   * @param masterKeyBase64 the current key.
   * @param previousKeysBase64 retired keys, kept only so rows encrypted under them can still be read.
   */
  constructor(masterKeyBase64: string, previousKeysBase64: string[] = []) {
    this.current = LocalKeyProvider.parse(masterKeyBase64);
    this.keyId = LocalKeyProvider.idOf(this.current);
    this.keys.set(this.keyId, this.current);
    for (const k of previousKeysBase64) {
      const key = LocalKeyProvider.parse(k);
      this.keys.set(LocalKeyProvider.idOf(key), key);
    }
  }

  private static parse(base64: string): Buffer {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) throw new Error('master key must be 32 bytes');
    return key;
  }

  /** A short fingerprint, not reversible to the key. */
  private static idOf(key: Buffer): string {
    return `local-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  }

  wrap(dataKey: Buffer): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current, iv);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Promise.resolve(Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url'));
  }

  unwrap(wrapped: string, keyId: string): Promise<Buffer> {
    const key = this.keys.get(keyId);
    if (!key) return Promise.reject(new Error('unknown master key id'));
    try {
      const raw = Buffer.from(wrapped, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      return Promise.resolve(
        Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]),
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error('unwrap failed'));
    }
  }
}
