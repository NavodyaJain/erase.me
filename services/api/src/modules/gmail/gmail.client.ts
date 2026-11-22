import { z } from 'zod';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6;
/** The slowest pace the client falls back to when Gmail keeps throttling: one request per second. */
const SLOWEST_INTERVAL_MS = 1000;
const METADATA_HEADERS = ['From', 'Reply-To', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id'] as const;

export type GmailApiErrorCode = 'auth' | 'quota' | 'unavailable';

/**
 * Why a call failed, for logs. Only these fields: which call, the HTTP status, and the `reason` and `status`
 * strings Google puts in its error object. Never the message text or any part of the response body, which can
 * quote mailbox content. Values are restricted to identifier-like strings.
 */
export interface GmailFailure {
  call: 'token.refresh' | 'messages.list' | 'messages.get';
  httpStatus?: number;
  /** For example `accessNotConfigured`, `rateLimitExceeded`, `SERVICE_DISABLED`. */
  reason?: string;
  /** Google's canonical status, for example `PERMISSION_DENIED`. */
  googleStatus?: string;
  /** Set when there was no usable HTTP answer. */
  cause?: 'network' | 'timeout' | 'bad_response' | 'retries_exhausted' | 'token_unreadable';
}

/** Carries a code and a content-free failure description, never a response body. */
export class GmailApiError extends Error {
  constructor(
    readonly code: GmailApiErrorCode,
    readonly failure?: GmailFailure,
  ) {
    super(`gmail api: ${code}`);
    this.name = 'GmailApiError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const safe = (v: unknown): string | undefined => (typeof v === 'string' && IDENTIFIER.test(v) ? v : undefined);

/** Pulls only `error.status` and the first `reason` out of a Google error body. */
export function readGoogleError(text: string): { reason?: string; googleStatus?: string } {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error as
      | { status?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> }
      | undefined;
    if (!e || typeof e !== 'object') return {};
    const reason = safe(e.errors?.[0]?.reason) ?? safe(e.details?.find((d) => safe(d.reason))?.reason);
    const googleStatus = safe(e.status);
    return { ...(reason ? { reason } : {}), ...(googleStatus ? { googleStatus } : {}) };
  } catch {
    return {};
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
  /** Reply-To header text. Used only to name the brand behind an email-delivery service. */
  replyTo: string | undefined;
  /**
   * Hostnames found in the List-Unsubscribe header (from its mailto: and https: targets). The header value
   * itself, which can carry per-recipient tokens, never leaves the client.
   */
  listUnsubscribeHosts: string[];
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

// Lenient on purpose: Gmail returns odd values for badly dated mail (for example a non-numeric or
// non-positive `internalDate`), and one such message must not fail a whole scan.
const MessageResponse = z.object({
  id: z.string(),
  internalDate: z.string().optional(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string().optional() })).default([]) }).optional(),
});

/** Hostnames only: `<mailto:u@brand.example?subject=x>, <https://list.brand.example/u/TOKEN>` -> both hosts. */
export function unsubscribeHosts(value: string | undefined): string[] {
  const hosts = new Set<string>();
  for (const m of (value ?? '').matchAll(/<\s*(mailto:|https?:\/\/)([^>\s]+)\s*>/gi)) {
    const scheme = (m[1] ?? '').toLowerCase();
    const rest = m[2] ?? '';
    try {
      const host = scheme === 'mailto:' ? (rest.split('?')[0] ?? '').split('@')[1] : new URL(`${scheme}//${rest}`).hostname;
      if (host && /^[a-z0-9.-]+$/i.test(host)) hosts.add(host.toLowerCase());
    } catch {
      // An unparsable target is ignored.
    }
  }
  return [...hosts];
}

const EARLIEST_PLAUSIBLE = Date.UTC(1995, 0, 1);
const CLOCK_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * When the message arrived. Gmail's `internalDate` (epoch milliseconds) when it is a plausible date,
 * otherwise the `Date` header, otherwise undefined (the message cannot be placed in time and is skipped).
 */
export function resolveReceivedAt(internalDate: string | undefined, dateHeader: string | undefined, nowMs: number): Date | undefined {
  const plausible = (ms: number): boolean => Number.isFinite(ms) && ms >= EARLIEST_PLAUSIBLE && ms <= nowMs + CLOCK_SKEW_MS;
  if (internalDate !== undefined && /^\d+$/.test(internalDate) && plausible(Number(internalDate))) return new Date(Number(internalDate));
  if (dateHeader !== undefined) {
    const ms = Date.parse(dateHeader);
    if (plausible(ms)) return new Date(ms);
  }
  return undefined;
}

export interface HttpGmailClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseUrl?: string;
  /**
   * Starting pace for all calls from this client. Unset means unlimited (tests). Gmail allows about 250 quota
   * units per second per user and messages.get costs 5, so parallel gets at full speed trip `rateLimitExceeded`.
   * On a throttle response the client slows down and pauses every caller, then speeds back up as calls succeed.
   */
  maxRequestsPerSecond?: number;
  now?: () => number;
}

export class HttpGmailClient implements GmailClient {
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly base: string;
  private readonly now: () => number;
  private readonly baseIntervalMs: number;
  private intervalMs: number;
  private nextSlotAt = 0;
  private pausedUntil = 0;

  constructor(opts: HttpGmailClientOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.baseIntervalMs = opts.maxRequestsPerSecond ? 1000 / opts.maxRequestsPerSecond : 0;
    this.intervalMs = this.baseIntervalMs;
    this.http = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.base = opts.baseUrl ?? API;
  }

  async listMessageIds(accessToken: string, q: { query: string; pageToken?: string; maxResults: number }): Promise<MessagePage> {
    const params = new URLSearchParams({ q: q.query, maxResults: String(q.maxResults), includeSpamTrash: 'false' });
    if (q.pageToken) params.set('pageToken', q.pageToken);
    const res = await this.get('messages.list', `${this.base}/messages?${params.toString()}`, accessToken);
    const parsed = ListResponse.safeParse(res);
    if (!parsed.success) throw new GmailApiError('unavailable', { call: 'messages.list', cause: 'bad_response' });
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
    const res = await this.get(
      'messages.get',
      `${this.base}/messages/${encodeURIComponent(id)}?${params.toString()}`,
      accessToken,
      true,
    );
    if (res === null) return null;
    const parsed = MessageResponse.safeParse(res);
    if (!parsed.success) throw new GmailApiError('unavailable', { call: 'messages.get', cause: 'bad_response' });
    const header = (name: string) =>
      parsed.data.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    const receivedAt = resolveReceivedAt(parsed.data.internalDate, header('Date'), Date.now());
    // A message with no usable date is skipped, like a deleted one. It is counted by the scan, not fatal.
    if (!receivedAt) return null;
    return {
      id: parsed.data.id,
      receivedAt,
      from: header('From'),
      subject: header('Subject'),
      hasListUnsubscribe: header('List-Unsubscribe') !== undefined,
      hasListId: header('List-Id') !== undefined,
      replyTo: header('Reply-To'),
      listUnsubscribeHosts: unsubscribeHosts(header('List-Unsubscribe')),
    };
  }

  /** GET with exponential backoff on 429 and 5xx (TRD 6.6). `allowMissing` turns a 404 into null. */
  private async get(
    call: 'messages.list' | 'messages.get',
    url: string,
    accessToken: string,
    allowMissing = false,
  ): Promise<unknown> {
    let last: GmailFailure = { call, cause: 'retries_exhausted' };
    let lastCode: GmailApiErrorCode = 'unavailable';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        await this.pace();
        res = await this.http(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        last = { call, cause: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network' };
        lastCode = 'unavailable';
        await this.backoff(attempt);
        continue;
      }
      if (res.ok) {
        this.speedUp();
        try {
          return await res.json();
        } catch {
          throw new GmailApiError('unavailable', { call, httpStatus: res.status, cause: 'bad_response' });
        }
      }
      if (res.status === 404 && allowMissing) return null;

      const failure: GmailFailure = { call, httpStatus: res.status, ...readGoogleError(await res.text().catch(() => '')) };
      if (res.status === 401) throw new GmailApiError('auth', failure);
      if (res.status === 403) {
        // 403 is either a rate limit (retry) or a revoked, insufficient or disabled-API error (stop).
        if (!/rateLimitExceeded|userRateLimitExceeded/i.test(failure.reason ?? '')) {
          throw new GmailApiError('auth', failure);
        }
        last = failure;
        lastCode = 'quota';
        await this.throttled(attempt, res.headers.get('retry-after'));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        last = failure;
        lastCode = res.status === 429 ? 'quota' : 'unavailable';
        if (res.status === 429) await this.throttled(attempt, res.headers.get('retry-after'));
        else await this.backoff(attempt, res.headers.get('retry-after'));
        continue;
      }
      throw new GmailApiError('unavailable', failure);
    }
    throw new GmailApiError(lastCode, last);
  }

  /** Spaces calls out. Slots are reserved synchronously, so parallel callers queue up in order. */
  private async pace(): Promise<void> {
    if (this.baseIntervalMs === 0) return;
    const t = this.now();
    const start = Math.max(t, this.nextSlotAt, this.pausedUntil);
    this.nextSlotAt = start + this.intervalMs;
    if (start > t) await this.sleep(start - t);
  }

  /** Gmail said slow down: widen the interval, pause everyone, then wait this caller's backoff. */
  private async throttled(attempt: number, retryAfter: string | null): Promise<void> {
    if (this.baseIntervalMs > 0) {
      this.intervalMs = Math.min(SLOWEST_INTERVAL_MS, Math.max(this.intervalMs * 2, this.baseIntervalMs * 2));
      const header = retryAfter ? Number(retryAfter) * 1000 : NaN;
      const wait = Number.isFinite(header) ? Math.min(header, 60_000) : Math.min(30_000, 1000 * 2 ** attempt);
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    }
    await this.backoff(attempt, retryAfter);
  }

  private speedUp(): void {
    if (this.intervalMs > this.baseIntervalMs) this.intervalMs = Math.max(this.baseIntervalMs, this.intervalMs * 0.9);
  }

  private backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const header = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const exp = Math.min(30_000, 500 * 2 ** attempt);
    return this.sleep(Number.isFinite(header) ? Math.min(header, 60_000) : exp + Math.floor(this.random() * 250));
  }
}
