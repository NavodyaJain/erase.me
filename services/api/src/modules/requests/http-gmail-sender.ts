import { z } from 'zod';
import { SenderOutcomeUnknownError, SenderRejectedError, type OutgoingMessage, type RequestSender, type SentMessage } from './sender.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TIMEOUT_MS = 20_000;

const SendResponse = z.object({ id: z.string().min(1), threadId: z.string().min(1) });
const HeaderResponse = z.object({ payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string().optional() })) }).optional() });

export interface HttpGmailSenderOptions {
  /** A short-lived access token for the inbox. Held in memory only. */
  getAccessToken(inboxId: string): Promise<string>;
  fetch?: typeof fetch;
  url?: string;
}

const hasLineBreak = (s: string): boolean => /[\r\n]/.test(s);
const wrap76 = (b64: string): string => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/**
 * Builds the raw RFC 2822 message Gmail's `messages.send` takes. Subject and body travel as base64 UTF-8, so no
 * character in them can add a header. Address and subject values containing a line break are refused.
 */
export function buildRawMessage(m: Pick<OutgoingMessage, 'from' | 'to' | 'subject' | 'body' | 'inReplyTo'>): string {
  if (hasLineBreak(m.from) || hasLineBreak(m.to) || hasLineBreak(m.subject) || /[<>,;]/.test(m.to) || /[<>,;]/.test(m.from)) {
    throw new SenderRejectedError();
  }
  // The id of the message a follow-up answers: a plain id, never anything that could add a header.
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (m.inReplyTo !== undefined && !/^[^<>\s\u0000-\u001f\u007f]{1,255}$/.test(m.inReplyTo)) throw new SenderRejectedError();
  const subject = `=?UTF-8?B?${Buffer.from(m.subject, 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`, `References: <${m.inReplyTo}>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')),
  ];
  return lines.join('\r\n');
}

/**
 * The real sender: Gmail `messages.send` from the user's own inbox (PRD F6). Only built when real sending is
 * switched on and the statute citation is verified (see selectSender). Errors carry no response content.
 * - A refusal (4xx) means nothing was sent: SenderRejectedError, safe to retry.
 * - A timeout, a server error or an unreadable answer may still mean the message went out: SenderOutcomeUnknownError.
 */
export class HttpGmailSender implements RequestSender {
  readonly mode = 'real' as const;
  private readonly http: typeof fetch;
  private readonly url: string;

  constructor(private readonly opts: HttpGmailSenderOptions) {
    this.http = opts.fetch ?? fetch;
    this.url = opts.url ?? SEND_URL;
  }

  async send(message: OutgoingMessage): Promise<SentMessage> {
    const raw = Buffer.from(buildRawMessage(message), 'utf8').toString('base64url');
    let token: string;
    try {
      token = await this.opts.getAccessToken(message.inboxId);
    } catch {
      throw new SenderRejectedError(); // no token, so nothing was sent
    }
    let res: Response;
    try {
      res = await this.http(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw, ...(message.threadId ? { threadId: message.threadId } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SenderOutcomeUnknownError();
    }
    if (res.status >= 400 && res.status < 500) throw new SenderRejectedError();
    if (!res.ok) throw new SenderOutcomeUnknownError();
    const parsed = SendResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SenderOutcomeUnknownError();
    const rfcMessageId = await this.readMessageIdHeader(token, parsed.data.id);
    return { threadId: parsed.data.threadId, messageId: parsed.data.id, ...(rfcMessageId ? { rfcMessageId } : {}), delivery: 'real' };
  }

  /**
   * The Message-ID header Gmail gave the sent message, so a later reply can be matched to it (In-Reply-To). One extra
   * headers-only call, best effort: if it fails the request is still sent and replies are matched by thread alone.
   */
  private async readMessageIdHeader(token: string, id: string): Promise<string | undefined> {
    try {
      const params = new URLSearchParams({ format: 'metadata', fields: 'payload/headers', metadataHeaders: 'Message-ID' });
      const res = await this.http(`${this.url.replace(/\/send$/, '')}/${encodeURIComponent(id)}?${params.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const body = HeaderResponse.safeParse(await res.json().catch(() => null));
      const value = body.success ? body.data.payload?.headers.find((h) => h.name.toLowerCase() === 'message-id')?.value : undefined;
      const match = value ? /<\s*([^<>\s]+)\s*>/.exec(value) : null;
      return match?.[1]?.toLowerCase();
    } catch {
      return undefined;
    }
  }
}
