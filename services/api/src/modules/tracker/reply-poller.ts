import { GmailApiError, type GmailClient, type GmailThreadMessage } from '../gmail/gmail.client.js';
import { registrableDomain } from '../gmail/signals.js';
import type { NewReply, PollableRequest, TrackerRepository } from './tracker.repository.js';

export interface ReplyPollerOptions {
  /** Checked requests are younger than this many days (REPLY_POLL_MAX_AGE_DAYS). */
  maxAgeDays: number;
  /** At most this many requests per run, so one run is short and Gmail is not hammered. */
  batchSize: number;
}

export interface ReplyPollerDeps {
  repo: TrackerRepository;
  gmail: GmailClient;
  /** A short-lived access token for an inbox, held in memory (InboxService.accessTokenById). Throws GmailApiError when the grant is gone. */
  accessToken(inboxId: string): Promise<string>;
  /** The addresses that belong to the person, to tell their own messages from a reply. Compared in memory only. */
  ownAddresses(userId: string): Promise<string[]>;
  now: () => Date;
  options: ReplyPollerOptions;
  /** Counts and codes only: never an address, a domain, a subject or an id. */
  log: { info(o: Record<string, unknown>, msg: string): void; warn(o: Record<string, unknown>, msg: string): void };
}

/** What one run did. Counts only, so it is safe to log. */
export interface PollCounts {
  checked: number;
  /** Requests that moved to reply_received. */
  replied: number;
  /** Replies recorded for the first time, and how many of them were automatic. */
  newReplies: number;
  automatic: number;
  threadMissing: number;
  failed: number;
  /** Inboxes skipped for the rest of the run because Google refused the grant. */
  inboxesStopped: number;
}

const domainOfAddress = (address: string | undefined): string | undefined => {
  const host = address?.split('@')[1];
  return host ? registrableDomain(host) : undefined;
};

/**
 * Looks for replies on the Gmail threads of sent requests, from message headers only (PRD F7, TRD 6.6).
 *
 * A message is a reply when it is not our own sent message, not from one of the person's own addresses, and answers our
 * message (its In-Reply-To or References has the Message-ID we sent; when that is unknown, any message from someone else
 * on the thread counts). Its sender is reduced to a registrable domain and compared with the company. Automatic replies
 * are recorded but do not change the status, and nothing here decides what a reply means: the person reports the outcome.
 */
export class ReplyPoller {
  constructor(private readonly deps: ReplyPollerDeps) {}

  async runOnce(): Promise<PollCounts> {
    const { repo, gmail, now, options, log } = this.deps;
    const counts: PollCounts = { checked: 0, replied: 0, newReplies: 0, automatic: 0, threadMissing: 0, failed: 0, inboxesStopped: 0 };
    const requests = await repo.listPollable(now(), options.maxAgeDays, options.batchSize);
    const stopped = new Set<string>();
    const own = new Map<string, string[]>();

    for (const req of requests) {
      if (stopped.has(req.inboxId)) continue;
      try {
        const token = await this.deps.accessToken(req.inboxId);
        const thread = await gmail.getThreadMetadata(token, req.threadId);
        counts.checked += 1;
        if (!thread) {
          counts.threadMissing += 1;
          await repo.recordCheck(req.requestId, now());
          continue;
        }
        let addresses = own.get(req.userId);
        if (!addresses) {
          addresses = await this.deps.ownAddresses(req.userId);
          own.set(req.userId, addresses);
        }
        const replies = this.repliesIn(req, thread.messages, new Set(addresses));
        const result = await repo.applyCheck(req.requestId, now(), replies);
        counts.newReplies += result.added;
        counts.automatic += result.addedAutomatic;
        if (result.moved) counts.replied += 1;
      } catch (err) {
        counts.failed += 1;
        await repo.recordFailedCheck(req.requestId, now()).catch(() => undefined);
        if (err instanceof GmailApiError && err.code === 'auth') {
          // The grant is gone (the inbox is marked by the token step): leave this inbox's other requests for later.
          if (!stopped.has(req.inboxId)) counts.inboxesStopped += 1;
          stopped.add(req.inboxId);
        }
      }
    }
    log.info({ ...counts }, 'reply check finished');
    return counts;
  }

  /** The replies among a thread's messages, as metadata. Exposed for tests. */
  repliesIn(req: PollableRequest, messages: GmailThreadMessage[], own: Set<string>): NewReply[] {
    const expected = new Set(
      [...req.companyDomains, ...(req.contactEmail ? [req.contactEmail.split('@')[1] ?? ''] : [])]
        .map((d) => registrableDomain(d))
        .filter((d): d is string => Boolean(d)),
    );
    const ours = req.sentRfcMessageId?.toLowerCase();
    const replies: NewReply[] = [];
    for (const m of messages) {
      if (m.id === req.sentMessageId) continue;
      if (m.fromAddress && own.has(m.fromAddress)) continue;
      const answersUs = ours === undefined || m.inReplyTo === ours || m.references.includes(ours);
      if (!answersUs) continue;
      const domain = domainOfAddress(m.fromAddress);
      replies.push({
        gmailMessageId: m.id,
        receivedAt: m.receivedAt,
        senderDomain: domain ?? null,
        senderMatch: domain === undefined ? 'unknown' : expected.has(domain) ? 'company' : 'other',
        automatic: m.automatic,
      });
    }
    return replies;
  }
}
