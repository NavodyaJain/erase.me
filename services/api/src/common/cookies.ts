export interface CookieOptions {
  maxAgeSec?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict';
}

/** Parses a Cookie header. Later duplicates of a name are ignored. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // A malformed value is treated as absent.
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`];
  if (o.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAgeSec))}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.httpOnly !== false) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
