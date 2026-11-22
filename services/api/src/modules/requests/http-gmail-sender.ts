import { z } from 'zod';
import { SenderOutcomeUnknownError, SenderRejectedError, type OutgoingMessage, type RequestSender, type SentMessage } from './sender.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TIMEOUT_MS = 20_000;

const SendResponse = z.object({ id: z.string().min(1), threadId: z.string().min(1) });

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
export function buildRawMessage(m: Pick<OutgoingMessage, 'from' | 'to' | 'subject' | 'body'>): string {
  if (hasLineBreak(m.from) || hasLineBreak(m.to) || hasLineBreak(m.subject) || /[<>,;]/.test(m.to) || /[<>,;]/.test(m.from)) {
    throw new SenderRejectedError();
  }
  const subject = `=?UTF-8?B?${Buffer.from(m.subject, 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
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
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SenderOutcomeUnknownError();
    }
    if (res.status >= 400 && res.status < 500) throw new SenderRejectedError();
    if (!res.ok) throw new SenderOutcomeUnknownError();
    const parsed = SendResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SenderOutcomeUnknownError();
    return { threadId: parsed.data.threadId, messageId: parsed.data.id, delivery: 'real' };
  }
}
