import { randomBytes } from 'node:crypto';
import { isRealSendEnabled, type Env } from '../../config/env.js';

/** One message to hand to a sender. Never logged. */
export interface OutgoingMessage {
  inboxId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  requestId: string;
}

export interface SentMessage {
  threadId: string;
  messageId: string;
  delivery: 'fake' | 'real';
}

/** The sender definitely did not send the message (for example Gmail refused it). Safe to try again. */
export class SenderRejectedError extends Error {
  constructor() {
    super('sender rejected the message');
    this.name = 'SenderRejectedError';
  }
}

/** Gmail may or may not have sent the message (a timeout, a server error, an unreadable answer). Never retried automatically. */
export class SenderOutcomeUnknownError extends Error {
  constructor() {
    super('send outcome unknown');
    this.name = 'SenderOutcomeUnknownError';
  }
}

export interface RequestSender {
  readonly mode: 'fake' | 'real';
  send(message: OutgoingMessage): Promise<SentMessage>;
}

/**
 * Stands in for Gmail in development and tests: nothing leaves the process. It keeps no message text unless a
 * test asks for it with `keepMessages`.
 */
export class FakeGmailSender implements RequestSender {
  readonly mode = 'fake' as const;
  calls = 0;
  readonly messages: OutgoingMessage[] = [];
  /** Tests use this to delay, or to throw SenderRejectedError or SenderOutcomeUnknownError. */
  beforeSend: ((m: OutgoingMessage) => Promise<void>) | undefined;

  constructor(private readonly keepMessages = false) {}

  async send(message: OutgoingMessage): Promise<SentMessage> {
    this.calls += 1;
    await this.beforeSend?.(message);
    if (this.keepMessages) this.messages.push(message);
    const id = randomBytes(6).toString('hex');
    return { threadId: `fake-thread-${id}`, messageId: `fake-message-${id}`, delivery: 'fake' };
  }
}

export type SenderChoice =
  | { kind: 'ready'; sender: RequestSender }
  | { kind: 'unavailable'; code: 'send_disabled' | 'real_send_blocked'; detail: string };

/**
 * Which sender a process uses. The rule, in order:
 * 1. ALLOW_REAL_SEND=true (and not a test run): real sending, but only once the statute citation is verified.
 *    Until then sending is refused outright, not quietly switched to the fake sender.
 * 2. Otherwise in development and test: the fake sender, clearly labelled in every response and event.
 * 3. Otherwise (staging, production with the flag off): sending is disabled.
 */
export function selectSender(env: Env, opts: { citationVerified: boolean; real: () => RequestSender }): SenderChoice {
  if (env.ALLOW_REAL_SEND && env.NODE_ENV !== 'test') {
    if (!isRealSendEnabled(env)) {
      return { kind: 'unavailable', code: 'send_disabled', detail: 'Real sending is switched off.' };
    }
    if (!opts.citationVerified) {
      return {
        kind: 'unavailable',
        code: 'real_send_blocked',
        detail: 'Real sending stays off until the statute citation in the draft template has been verified.',
      };
    }
    return { kind: 'ready', sender: opts.real() };
  }
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return { kind: 'ready', sender: new FakeGmailSender() };
  return { kind: 'unavailable', code: 'send_disabled', detail: 'Sending is not switched on in this environment.' };
}
