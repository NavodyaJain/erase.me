import { z } from 'zod';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;
const METADATA_HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id'] as const;

export type GmailApiErrorCode = 'auth' | 'quota' | 'unavailable';

/** Carries a code only, never a response body (bodies can quote mailbox content). */
export class GmailApiError extends Error {
  constructor(readonly code: GmailApiErrorCode) {
    super(`gmail api: ${code}`);
    this.name = 'GmailApiError';
  }
}

/**
 * Header metadata of one message. The scan reads these in memory to derive signals and keeps none of them:
 * no subject, no sender name, no body (PRD F2-AC4, section 8).
 */
export interface GmailMessageMeta {
  id: string;
  receivedAt: Date;
  from: string | undefined;
  subject: string | undefined;
  hasListUnsubscribe: boolean;
  hasListId: boolean;
}

export interface MessagePage {
  ids: string[];
  nextPageToken?: string;
  /** Gmail's rough estimate of the total matches. Used only for progress. */
  estimatedTotal?: number;
}

/** What the scan needs from Gmail. The fake Gmail server and test doubles implement the same interface. */
export interface GmailClient {
  listMessageIds(accessToken: string, q: { query: string; pageToken?: string; maxResults: number }): Promise<MessagePage>;
  /** Metadata only. Returns null when the message no longer exists. */
  getMessageMetadata(accessToken: string, id: string): Promise<GmailMessageMeta | null>;
}

const ListResponse = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

const MessageResponse = z.object({
  id: z.string(),
  internalDate: z.string().regex(/^\d+$/),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }).optional(),
});

export interface HttpGmailClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseUrl?: string;
}

export class HttpGmailClient implements GmailClient {
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly base: string;

  constructor(opts: HttpGmailClientOptions = {}) {
    this.http = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.base = opts.baseUrl ?? API;
  }

  async listMessageIds(accessToken: string, q: { query: string; pageToken?: string; maxResults: number }): Promise<MessagePage> {
    const params = new URLSearchParams({ q: q.query, maxResults: String(q.maxResults), includeSpamTrash: 'false' });
    if (q.pageToken) params.set('pageToken', q.pageToken);
    const res = await this.get(`${this.base}/messages?${params.toString()}`, accessToken);
    const parsed = ListResponse.safeParse(res);
    if (!parsed.success) throw new GmailApiError('unavailable');
    return {
      ids: (parsed.data.messages ?? []).map((m) => m.id),
      ...(parsed.data.nextPageToken ? { nextPageToken: parsed.data.nextPageToken } : {}),
      ...(parsed.data.resultSizeEstimate !== undefined ? { estimatedTotal: parsed.data.resultSizeEstimate } : {}),
    };
  }

  async getMessageMetadata(accessToken: string, id: string): Promise<GmailMessageMeta | null> {
    // format=metadata with an explicit header list: Gmail does not return the body or attachments.
    const params = new URLSearchParams({ format: 'metadata' });
    for (const h of METADATA_HEADERS) params.append('metadataHeaders', h);
    const res = await this.get(`${this.base}/messages/${encodeURIComponent(id)}?${params.toString()}`, accessToken, true);
    if (res === null) return null;
    const parsed = MessageResponse.safeParse(res);
    if (!parsed.success) throw new GmailApiError('unavailable');
    const header = (name: string) =>
      parsed.data.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    return {
      id: parsed.data.id,
      receivedAt: new Date(Number(parsed.data.internalDate)),
      from: header('From'),
      subject: header('Subject'),
      hasListUnsubscribe: header('List-Unsubscribe') !== undefined,
      hasListId: header('List-Id') !== undefined,
    };
  }

  /** GET with exponential backoff on 429 and 5xx (TRD 6.6). `allowMissing` turns a 404 into null. */
  private async get(url: string, accessToken: string, allowMissing = false): Promise<unknown> {
    let lastQuota = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.http(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        await this.backoff(attempt);
        lastQuota = false;
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 404 && allowMissing) return null;
      if (res.status === 401) throw new GmailApiError('auth');
      if (res.status === 403) {
        // 403 is either a rate limit (retry) or a revoked or insufficient grant (stop).
        const reason = await res.text().catch(() => '');
        if (!/rateLimitExceeded|userRateLimitExceeded/.test(reason)) throw new GmailApiError('auth');
        lastQuota = true;
        await this.backoff(attempt, res.headers.get('retry-after'));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastQuota = res.status === 429;
        await this.backoff(attempt, res.headers.get('retry-after'));
        continue;
      }
      throw new GmailApiError('unavailable');
    }
    throw new GmailApiError(lastQuota ? 'quota' : 'unavailable');
  }

  private backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const header = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const exp = Math.min(30_000, 500 * 2 ** attempt);
    return this.sleep(Number.isFinite(header) ? Math.min(header, 60_000) : exp + Math.floor(this.random() * 250));
  }
}
