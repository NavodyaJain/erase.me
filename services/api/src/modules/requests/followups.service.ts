import { AppError, Problems } from '../../common/errors.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { InboxService } from '../gmail/inbox.service.js';
import { hashDraft, isDraftHash } from './draft-hash.js';
import { explainFindings, findSafetyIssues, ID_FINDINGS } from './draft-safety.js';
import { contactChangedBlocker, followupDraftBlockers, followupDueAt, isWaitingForAnswer, REAL_FOLLOWUP_BLOCKED, type FollowupSettings } from './followup-state.js';
import { renderFollowup } from './followup-template.js';
import { companyBlockers, throwBlocker, titleFor, type Blocker } from './request-guards.js';
import type { ClaimRow, CompanyContext, DraftRow, FollowupRow, RequestRow, RequestsRepository, RequestsTx } from './requests.repository.js';
import { SenderOutcomeUnknownError, SenderRejectedError, type SenderChoice, type SentMessage } from './sender.js';
import { assertTransition, eventFor } from './state-machine.js';

export interface FollowupSendResponse {
  followup: { sequence: number; status: 'sent'; sentAt: string };
  delivery: 'fake' | 'real';
  /** Set when nothing really left the machine. */
  notice?: string;
}

export interface FollowupsServiceDeps {
  repo: RequestsRepository;
  audit: AuditRepository;
  inboxes: Pick<InboxService, 'accessTokenFor'>;
  sender: SenderChoice;
  realSendDailyCap: number;
  settings: FollowupSettings;
  now?: () => Date;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

/** What one run of the sweep did. Counts only, so it is safe to log. */
export interface SweepCounts {
  considered: number;
  drafted: number;
  /** Not drafted because a guard said no (a missing or bounced contact, for example). */
  blocked: number;
  failed: number;
}

const FAKE_NOTICE = 'No email was sent. This is a development send to the fake sender.';

type Actor = 'user' | 'system';

/**
 * Follow-ups (PRD F7, Phase 2): one polite follow-up to a request that has had no reply by FOLLOWUP_AFTER_DAYS. It is part
 * of the same request and Gmail thread. The rules mirror the first request's:
 * - the person approves the exact draft (its hash) before anything is sent, and an edit makes a new draft that needs approving again;
 * - the guards (kept, must-keep, excluded, a verified contact, ID-like numbers, the [OPEN] line) run at create, approve and send;
 * - a send is idempotent (same Idempotency-Key, same answer), a changed draft is refused with `draft_changed` and never retried by itself,
 *   and a database trigger refuses to mark an unapproved follow-up sent;
 * - real sending stays behind the same gates as the first request, and also behind the sign-off of the follow-up wording;
 * - for a web-form request the follow-up is copy-only: the person pastes it into the form and says so. Nothing is sent.
 * An automatic reply does not stop the clock (it never changes the request's status), and a reply from a person or a reported
 * outcome ends the wait, so no follow-up is offered or sent after either.
 */
export class FollowupsService {
  private readonly now: () => Date;
  private readonly log: NonNullable<FollowupsServiceDeps['log']>;

  constructor(private readonly deps: FollowupsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? { info: () => undefined, warn: () => undefined };
  }

  // ---- create ----

  /**
   * Prepares the follow-up draft for a request that is due one. Asking again returns the draft that exists. A request still
   * `sent` moves to `no_reply` (the follow-up day has passed with nothing received).
   */
  async create(userId: string, requestId: string, by: Actor = 'user'): Promise<void> {
    let drafted: { sequence: number } | undefined;
    await this.deps.repo.transaction(async (tx) => {
      const found = await this.load(tx, userId, requestId);
      const { req, ctx, firstDraft } = found;

      const followups = (await tx.followups(req.id)).filter((f) => f.status !== 'cancelled');
      if (followups.some((f) => f.status === 'drafted' || f.status === 'approved')) return; // the draft that exists is the answer
      if (!isWaitingForAnswer(req.status)) throw waitOver(req.status);
      const max = this.deps.settings.max;
      if (max <= 0 || followups.length >= max) {
        throw new AppError(409, 'followup_limit_reached', 'No more follow-ups for this request', max <= 0 ? 'Follow-ups are switched off.' : `A request has at most ${max} follow-up${max === 1 ? '' : 's'}, and it has had them.`);
      }
      const last = followups.at(-1);
      const dueFrom = last?.sentAt ?? req.sentAt;
      if (!dueFrom || !req.sentAt) throw new AppError(409, 'invalid_transition', 'This request has not been sent', 'A follow-up is only offered for a request that was sent.');
      const dueAt = followupDueAt(dueFrom, this.deps.settings.afterDays);
      if (this.now().getTime() < dueAt.getTime()) {
        throw new AppError(409, 'followup_not_due', 'Too early for a follow-up', `A follow-up is offered ${this.deps.settings.afterDays} days after the last message, on ${dueAt.toISOString().slice(0, 10)}. Replies can be slow.`);
      }
      const blocker = companyBlockers(ctx)[0] ?? contactChangedBlocker(ctx, req.channel, firstDraft.toEmail);
      if (blocker) throwBlocker(blocker);

      const profile = await tx.profile(userId);
      if (!profile) throw Problems.unauthorized();
      const text = renderFollowup({ userName: profile.name, userEmail: profile.email, companyName: ctx.companyName, signals: ctx.signals, sentAt: req.sentAt, channel: req.channel });
      const hash = hashDraft({ to: firstDraft.toEmail, subject: text.subject, body: text.body });
      const followup = await tx.insertFollowup(req.id, (followups.at(-1)?.sequence ?? 0) + 1);
      if (!followup) return; // another call made it first: that draft is the answer

      if (req.status === 'sent') {
        assertTransition('sent', 'no_reply');
        await tx.insertEvent({ requestId: req.id, type: eventFor('sent', 'no_reply'), actorType: by, ...(by === 'user' ? { actorId: userId } : {}), payload: { from: 'sent', to: 'no_reply', reason: 'followup_day', afterDays: this.deps.settings.afterDays } });
        await tx.setStatus(req.id, 'no_reply');
      }
      await tx.insertFollowupDraft({ requestId: req.id, followupId: followup.id, version: 1, to: firstDraft.toEmail, subject: text.subject, body: text.body, hash, createdBy: 'template' });
      await tx.insertEvent({ requestId: req.id, type: 'followup_drafted', actorType: by, ...(by === 'user' ? { actorId: userId } : {}), draftHash: hash, payload: { sequence: followup.sequence, version: 1 } });
      drafted = { sequence: followup.sequence };
    });
    if (drafted) {
      await this.deps.audit.record({ actorType: by, ...(by === 'user' ? { actorId: userId } : {}), action: 'request.followup_drafted', targetType: 'request', targetId: requestId });
      this.log.info({ requestId, sequence: drafted.sequence, by }, 'follow-up drafted');
    }
  }

  /**
   * The daily (hourly) sweep: for each request whose follow-up day has come, prepare the follow-up draft. It skips a person who asked
   * to delete their data, a company they keep, a must-keep company and one they marked as not theirs (the query leaves them out), and
   * a request that has had a reply or an outcome. Idempotent: a request that has a follow-up is not a candidate again.
   */
  async sweep(limit = 100): Promise<SweepCounts> {
    const counts: SweepCounts = { considered: 0, drafted: 0, blocked: 0, failed: 0 };
    if (this.deps.settings.max <= 0) return counts;
    const candidates = await this.deps.repo.followupCandidates(this.now(), this.deps.settings.afterDays, limit);
    for (const c of candidates) {
      counts.considered += 1;
      try {
        await this.create(c.userId, c.requestId, 'system');
        counts.drafted += 1;
      } catch (err) {
        if (err instanceof AppError) counts.blocked += 1;
        else counts.failed += 1;
      }
    }
    this.log.info({ ...counts }, 'follow-up sweep finished');
    return counts;
  }

  // ---- edit ----

  /** A new draft version. The earlier approval no longer matches, so the follow-up goes back to drafted. */
  async editDraft(userId: string, requestId: string, input: { baseHash: string; subject: string; body: string }): Promise<void> {
    const idFindings = findSafetyIssues(input.subject, input.body).filter((f) => ID_FINDINGS.includes(f));
    if (idFindings.length) throw new AppError(422, 'draft_unsafe', titleFor('draft_unsafe'), explainFindings(idFindings), { findings: idFindings });

    await this.deps.repo.transaction(async (tx) => {
      const { req } = await this.load(tx, userId, requestId);
      const followup = await this.current(tx, req.id);
      if (followup.status === 'sent' || followup.status === 'submitted') throw new AppError(409, 'request_not_editable', 'This follow-up can no longer be edited', 'It was already sent.');
      if (followup.status === 'cancelled') throw Problems.notFound();
      if (!isWaitingForAnswer(req.status)) throw waitOver(req.status);
      if (await tx.activeFollowupClaim(followup.id)) throw new AppError(409, 'send_in_progress', 'This follow-up is being sent', 'It cannot be edited while it is being sent.');
      const latest = await tx.latestFollowupDraft(followup.id);
      if (!latest) throw Problems.notFound();
      if (!isDraftHash(input.baseHash) || input.baseHash !== latest.draftHash) throw new AppError(409, 'draft_changed', 'The draft changed', 'Reload the follow-up and edit the latest version.');
      const hash = hashDraft({ to: latest.toEmail, subject: input.subject, body: input.body });
      if (hash === latest.draftHash) return; // nothing changed: no new version
      const version = latest.version + 1;
      await tx.insertFollowupDraft({ requestId: req.id, followupId: followup.id, version, to: latest.toEmail, subject: input.subject, body: input.body, hash, createdBy: 'user' });
      if (followup.status === 'approved') await tx.setFollowup(followup.id, { status: 'drafted', approvedHash: null });
      await tx.insertEvent({ requestId: req.id, type: 'edited', actorType: 'user', actorId: userId, draftHash: hash, payload: { followup: followup.sequence, version } });
    });
  }

  // ---- approve ----

  /** The person's approval of exactly the follow-up draft they were shown. */
  async approve(userId: string, requestId: string, draftHash: string): Promise<void> {
    await this.deps.repo.transaction(async (tx) => {
      const { req, ctx, firstDraft } = await this.load(tx, userId, requestId);
      const followup = await this.current(tx, req.id);
      const latest = await tx.latestFollowupDraft(followup.id);
      if (!latest) throw Problems.notFound();
      if (followup.status === 'sent' || followup.status === 'submitted') throw new AppError(409, 'already_sent', 'Already sent', 'This follow-up was already sent.');
      if (followup.status === 'cancelled') throw Problems.notFound();
      if (req.channel === 'web_form') throw useFormStop(ctx, latest);
      if (!isWaitingForAnswer(req.status)) throw waitOver(req.status);
      if (!isDraftHash(draftHash) || draftHash !== latest.draftHash) throw new AppError(409, 'draft_changed', 'The draft changed', 'The text you approved is not the latest version. Review it again.');
      if (followup.status === 'approved' && (await tx.hasFollowupApproval(req.id, latest.draftHash, latest.createdAt))) return; // already approved
      const blocker = followupDraftBlockers(ctx, req.channel, firstDraft.toEmail, latest)[0];
      if (blocker) throwBlocker(blocker);
      await tx.insertEvent({ requestId: req.id, type: 'followup_approved', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { sequence: followup.sequence, version: latest.version } });
      await tx.setFollowup(followup.id, { status: 'approved', approvedHash: latest.draftHash });
    });
  }

  // ---- web form: copy-only ----

  /**
   * For a web-form request: the person pasted the follow-up into the company's form. Nothing is sent. It is recorded like the first
   * request's "mark as submitted": the person names the exact draft they copied, the guards run again, and the approval and the
   * submission are recorded together.
   */
  async markSubmitted(userId: string, requestId: string, draftHash: string): Promise<void> {
    await this.deps.repo.transaction(async (tx) => {
      const { req, ctx, firstDraft } = await this.load(tx, userId, requestId);
      const followup = await this.current(tx, req.id);
      if (followup.status === 'submitted') return; // already marked
      if (followup.status === 'sent') throw new AppError(409, 'already_sent', 'Already sent', 'This follow-up was already sent by email.');
      if (followup.status === 'cancelled') throw Problems.notFound();
      if (req.channel !== 'web_form') throw new AppError(409, 'not_a_form_request', 'This company does not use a web form', `${ctx.companyName} takes requests by email. Review the follow-up, approve it and send it instead.`);
      if (!isWaitingForAnswer(req.status)) throw waitOver(req.status);
      const latest = await tx.latestFollowupDraft(followup.id);
      if (!latest) throw Problems.notFound();
      if (!isDraftHash(draftHash) || draftHash !== latest.draftHash) throw new AppError(409, 'draft_changed', 'The draft changed', 'The text you copied is not the latest version. Copy the latest follow-up before you say you submitted it.');
      const blocker = followupDraftBlockers(ctx, req.channel, firstDraft.toEmail, latest)[0];
      if (blocker) throwBlocker(blocker);
      if (!(await tx.hasFollowupApproval(req.id, latest.draftHash, latest.createdAt))) {
        await tx.insertEvent({ requestId: req.id, type: 'followup_approved', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { sequence: followup.sequence, version: latest.version, forForm: true } });
      }
      await tx.setFollowup(followup.id, { status: 'submitted', approvedHash: latest.draftHash, sentAt: this.now() });
      await tx.insertEvent({ requestId: req.id, type: 'submitted', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { followup: followup.sequence, version: latest.version } });
    });
    await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'request.followup_submitted', targetType: 'request', targetId: requestId });
  }

  // ---- send ----

  /**
   * Sends an approved follow-up, in the first message's Gmail thread. The rules, in order: the same Idempotency-Key replays the stored
   * answer and never sends twice; only an approved follow-up whose latest draft has a user approval of its exact hash can be sent (the
   * database enforces it again); the guards run again; a claim is recorded before the sender is called; and an unknown outcome leaves
   * the claim in progress and the follow-up unsent, on purpose. Real sending needs the same gates as the first request and the sign-off
   * of the follow-up wording.
   */
  async send(userId: string, requestId: string, key: string): Promise<{ status: number; body: FollowupSendResponse }> {
    if (this.deps.sender.kind === 'unavailable') throw new AppError(503, this.deps.sender.code, 'Sending is not available', this.deps.sender.detail);
    const sender = this.deps.sender.sender;
    if (sender.mode === 'real' && !this.deps.settings.wordingSignedOff) throw new AppError(503, 'real_send_blocked', 'Real follow-ups are off', REAL_FOLLOWUP_BLOCKED);

    const phaseA = await this.deps.repo.transaction(async (tx) => {
      const { req, ctx, firstDraft } = await this.load(tx, userId, requestId);
      if (await tx.deletionPending(userId)) throw Problems.deletionPending();
      const followup = await this.current(tx, req.id);

      const prior = await tx.findClaim(userId, 'followup_send', key);
      if (prior) {
        if (prior.requestId !== req.id || prior.followupId !== followup.id) {
          throw new AppError(422, 'idempotency_key_reuse', 'Idempotency key already used', 'This key was used for a different request. Use a new key.');
        }
        if (prior.status === 'completed' && prior.response) return { replay: { status: prior.responseStatus ?? 200, body: prior.response as unknown as FollowupSendResponse } };
        if (prior.status === 'in_progress') throw new AppError(409, 'send_in_progress', 'This follow-up is being sent', 'A send with this key is already running or its result is unknown. Check the Sent folder in Gmail.');
      }
      if (followup.status === 'sent' || followup.status === 'submitted') throw new AppError(409, 'already_sent', 'Already sent', 'This follow-up was already sent.');
      if (followup.status === 'cancelled') throw Problems.notFound();
      const latest = await tx.latestFollowupDraft(followup.id);
      if (!latest) throw Problems.notFound();
      if (req.channel === 'web_form') throw useFormStop(ctx, latest);
      if (followup.status !== 'approved') throw new AppError(409, 'approval_required', 'Approval needed', 'Review the follow-up and approve it before sending. Nothing is sent without your approval.');
      if (!isWaitingForAnswer(req.status)) throw waitOver(req.status);
      if (!(await tx.hasFollowupApproval(req.id, latest.draftHash, latest.createdAt))) {
        throw new AppError(409, 'approval_required', 'Approval needed', 'The latest follow-up has not been approved. Review it and approve it before sending.');
      }
      const blocker = followupDraftBlockers(ctx, req.channel, firstDraft.toEmail, latest)[0];
      if (blocker) throwBlocker(blocker);
      if (!req.threadId) throw new AppError(409, 'invalid_transition', 'This request has no conversation to follow up in', 'The first message has no Gmail conversation on record.');

      if (sender.mode === 'real') {
        if (ctx.isFictional) throw new AppError(409, 'fictional_company', 'Sample company', 'This is a sample company. It cannot be sent for real.');
        const startOfDay = new Date(Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), this.now().getUTCDate()));
        if ((await tx.countRealSendsSince(userId, startOfDay)) >= this.deps.realSendDailyCap) {
          throw new AppError(429, 'daily_cap_reached', 'Daily limit reached', 'You have reached the daily limit for sent requests. Try again tomorrow.');
        }
      }
      const inbox = await tx.inbox(ctx.inboxId);
      if (!inbox || inbox.userId !== userId || inbox.status !== 'connected' || !inbox.scopes.includes('gmail.send')) {
        throw new AppError(409, 'inbox_not_connected', 'Inbox not connected', 'The inbox this company was found in is not connected. Reconnect it to send.');
      }
      let claim: ClaimRow | undefined;
      if (prior?.status === 'failed') claim = await tx.reclaim(prior.id);
      else claim = await tx.insertClaim(userId, req.id, key, followup.id);
      if (!claim) throw new AppError(409, 'send_in_progress', 'This follow-up is being sent', 'Another send for this follow-up is running or finished.');
      return { claim, draft: latest, inbox, followup, threadId: req.threadId, inReplyTo: req.sentRfcMessageId };
    });
    if (phaseA.replay) return phaseA.replay;

    let sent: SentMessage;
    try {
      sent = await sender.send({
        inboxId: phaseA.inbox.id,
        from: phaseA.inbox.email,
        to: phaseA.draft.toEmail,
        subject: phaseA.draft.subject,
        body: phaseA.draft.body,
        requestId,
        threadId: phaseA.threadId,
        ...(phaseA.inReplyTo ? { inReplyTo: phaseA.inReplyTo } : {}),
      });
    } catch (err) {
      if (err instanceof SenderRejectedError) {
        await this.deps.repo.failClaim(phaseA.claim.id);
        this.log.warn({ requestId, outcome: 'rejected' }, 'follow-up refused by sender');
        throw new AppError(502, 'send_failed', 'The message was not sent', 'Gmail did not accept the message, so nothing was sent. You can try again.');
      }
      this.log.warn({ requestId, outcome: err instanceof SenderOutcomeUnknownError ? 'unknown' : 'error' }, 'follow-up outcome unknown');
      throw unknownOutcome();
    }

    const sentAt = this.now();
    const body: FollowupSendResponse = {
      followup: { sequence: phaseA.followup.sequence, status: 'sent', sentAt: sentAt.toISOString() },
      delivery: sent.delivery,
      ...(sent.delivery === 'fake' ? { notice: FAKE_NOTICE } : {}),
    };
    try {
      await this.deps.repo.transaction(async (tx) => {
        const req = await tx.lockRequest(userId, requestId);
        if (!req) throw Problems.notFound();
        await tx.setFollowup(phaseA.followup.id, { status: 'sent', sentAt, gmailMessageId: sent.messageId });
        await tx.insertEvent({ requestId, type: 'followup_sent', actorType: 'user', actorId: userId, draftHash: phaseA.draft.draftHash, payload: { sequence: phaseA.followup.sequence, version: phaseA.draft.version, delivery: sent.delivery } });
        await tx.completeClaim(phaseA.claim.id, 200, body as unknown as Record<string, unknown>);
      });
    } catch {
      // The message went out but recording it failed. Leave the claim in progress so nothing is sent twice.
      this.log.warn({ requestId, outcome: 'unrecorded' }, 'follow-up sent but not recorded');
      throw unknownOutcome();
    }
    await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'request.followup_sent', targetType: 'request', targetId: requestId });
    this.log.info({ requestId, delivery: sent.delivery }, 'follow-up sent');
    return { status: 200, body };
  }

  // ---- shared ----

  private async load(tx: RequestsTx, userId: string, requestId: string): Promise<{ req: RequestRow; ctx: CompanyContext; firstDraft: DraftRow }> {
    const req = await tx.lockRequest(userId, requestId);
    if (!req) throw Problems.notFound();
    const ctx = await tx.contextForRequest(userId, requestId);
    const firstDraft = await tx.latestDraft(req.id);
    if (!ctx || !firstDraft) throw Problems.notFound();
    return { req, ctx, firstDraft };
  }

  /** The follow-up being worked on, or the last one. No follow-up at all looks like a missing one. */
  private async current(tx: RequestsTx, requestId: string): Promise<FollowupRow> {
    const live = (await tx.followups(requestId)).filter((f) => f.status !== 'cancelled');
    const current = live.at(-1);
    if (!current) throw new AppError(404, 'not_found', 'Not found', 'There is no follow-up for this request yet.');
    return current;
  }
}

const unknownOutcome = (): AppError =>
  new AppError(
    502,
    'send_outcome_unknown',
    'We could not confirm the message was sent',
    'Check the Sent folder in Gmail before doing anything else. Erase.me has not marked this follow-up as sent and will not retry it on its own.',
  );

/** A reply, an outcome the person reported, or a closed request ends the wait: nothing more is offered or sent. */
function waitOver(status: RequestRow['status']): AppError {
  const detail =
    status === 'reply_received'
      ? 'A reply has arrived on this request, so no follow-up is sent. Open it in Gmail to read it, then report what it says.'
      : status === 'drafted' || status === 'approved'
        ? 'This request has not been sent yet, so there is nothing to follow up.'
        : `A request that is ${status} has no follow-up to send.`;
  return new AppError(409, 'invalid_transition', 'No follow-up is needed', detail);
}

/** A web-form request: the follow-up is copy-only. The link to the form is given instead. */
function useFormStop(ctx: CompanyContext, draft: DraftRow): AppError {
  const formUrl = ctx.grievanceFormUrl ?? draft.toEmail;
  const blocker: Blocker = { code: 'use_form', status: 409, message: `${ctx.companyName} takes requests through a web form, so a follow-up cannot be sent by email. Copy it into the form, then say you submitted it.`, extra: { formUrl, ...(ctx.selfServeUrl ? { selfServeUrl: ctx.selfServeUrl } : {}) } };
  return new AppError(blocker.status, blocker.code, titleFor(blocker.code), blocker.message, blocker.extra);
}
