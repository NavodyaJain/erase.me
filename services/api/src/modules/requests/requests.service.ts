import { AppError, Problems } from '../../common/errors.js';
import { isId } from '../../common/ids.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { InboxService } from '../gmail/inbox.service.js';
import { hashDraft, isDraftHash } from './draft-hash.js';
import { explainFindings, findSafetyIssues, ID_FINDINGS, type SafetyFinding } from './draft-safety.js';
import { renderDraft } from './draft-template.js';
import { FOLLOWUP_WORDING } from './followup-template.js';
import { summariseFollowup, type FollowupSettings, type FollowupSummary } from './followup-state.js';
import { isReportedOutcome, isWaiting, outcomeOfStatus, reportedOutcomeOf, statusForOutcome, TRACKING_STATUSES, type OutcomeValue } from './outcomes.js';
import type { ClaimRow, DraftRow, EventRow, ReplySummary, RequestRow, RequestsRepository, RequestsTx } from './requests.repository.js';
import { SenderOutcomeUnknownError, SenderRejectedError, type SenderChoice, type SentMessage } from './sender.js';
import { assertTransition, eventFor, PRE_SEND_STATUSES, type RequestStatus } from './state-machine.js';
import { assertEmailRequest, companyBlockers, destinationOf, draftBlockers, throwBlocker, titleFor, useFormMessage, type Blocker } from './request-guards.js';
export { destinationOf, draftBlockers, keptMessage, mustKeepMessage, type Blocker } from './request-guards.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DRAFTS_PER_CALL = 10;

export interface DraftOutcome {
  userCompanyId: string;
  /**
   * `created` and `existing`: an email request. `use_form`: the company takes requests through a web form, so the
   * request holds a draft to copy and `formUrl` says where to paste it. `kept`: the user chose to keep this company, so
   * no request is made. `blocked`: see `reason` and `message`.
   */
  outcome: 'created' | 'existing' | 'use_form' | 'kept' | 'blocked';
  requestId?: string;
  reason?: Blocker['code'] | 'not_found';
  message?: string;
  formUrl?: string;
  /** The company's own account-deletion page, when it has one, to show before a request by email. */
  selfServeUrl?: string;
}

export interface RequestView {
  request: { id: string; status: RequestStatus; channel: 'email' | 'web_form'; createdAt: Date; updatedAt: Date; sentAt: Date | null; dueAt: Date | null };
  company: { id: string; name: string; mustKeep: boolean; kept: boolean; selfServeUrl: string | null };
  /** How the company takes requests. For `web_form` the draft is for copy and paste and cannot be sent by email. */
  contact: { channel: 'email' | 'web_form'; formUrl: string | null };
  useForm: boolean;
  draft: { version: number; to: string; subject: string; body: string; hash: string; createdBy: string; createdAt: Date };
  approved: boolean;
  events: Array<{ type: string; actor: string; at: Date; payload: Record<string, unknown> }>;
  canSend: boolean;
  blockers: Array<{ code: string; message: string; findings?: SafetyFinding[]; formUrl?: string }>;
  /** Replies seen on the Gmail thread, from message headers only: counts and times, never what they said. */
  replies: ReplySummary;
  /**
   * What the person reports the company answered. Set by the person and never inferred, so it is always "Reported by
   * you". `no_answer_yet` while waiting. Null before the request is sent, and after it bounced.
   */
  outcome: { value: OutcomeValue; setByUser: boolean; at: Date | null } | null;
  /** A sent request can take an outcome. */
  canSetOutcome: boolean;
  /** A web-form request whose draft is ready: the person can say they pasted it into the form. */
  canMarkSubmitted: boolean;
  /**
   * The follow-up to a request with no reply: when it is due, its draft, whether it can be sent, and what blocks it. For a
   * web-form request it is copy-only.
   */
  followup: FollowupSummary;
}

export interface SendResponse {
  request: { id: string; status: 'sent'; sentAt: string; dueAt: string };
  delivery: 'fake' | 'real';
  /** Set when nothing really left the machine. */
  notice?: string;
}

export interface RequestsServiceDeps {
  repo: RequestsRepository;
  audit: AuditRepository;
  inboxes: Pick<InboxService, 'accessTokenFor'>;
  sender: SenderChoice;
  realSendDailyCap: number;
  now?: () => Date;
  /** Days after sending before a request counts as overdue (FOLLOWUP_AFTER_DAYS). Default 30. */
  followupAfterDays?: number;
  /** Follow-ups allowed per request (FOLLOWUP_MAX). Default 1; 0 turns them off. */
  followupMax?: number;
  /** The owner has signed off the follow-up wording. Default: FOLLOWUP_WORDING.signedOff (false). */
  followupWordingSignedOff?: boolean;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

const FAKE_NOTICE = 'No email was sent. This is a development send to the fake sender.';

export class RequestsService {
  private readonly now: () => Date;
  private readonly log: NonNullable<RequestsServiceDeps['log']>;
  private readonly followupSettings: FollowupSettings;

  constructor(private readonly deps: RequestsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.followupSettings = { afterDays: deps.followupAfterDays ?? 30, max: deps.followupMax ?? 1, wordingSignedOff: deps.followupWordingSignedOff ?? FOLLOWUP_WORDING.signedOff };
    this.log = deps.log ?? { info: () => undefined, warn: () => undefined };
  }

  // ---- create ----

  /** Batch create (TRD 6.3). Each company gets its own outcome; one blocked company does not stop the others. */
  async createDrafts(userId: string, userCompanyIds: string[], httpRequestId: string): Promise<DraftOutcome[]> {
    const profile = await this.deps.repo.profile(userId);
    if (!profile) throw Problems.unauthorized();
    const ids = [...new Set(userCompanyIds)].slice(0, MAX_DRAFTS_PER_CALL);
    const results: DraftOutcome[] = [];
    for (const userCompanyId of ids) {
      results.push(await this.createOne(userId, userCompanyId, profile, httpRequestId));
    }
    return results;
  }

  private async createOne(userId: string, userCompanyId: string, profile: { name: string; email: string }, httpRequestId: string): Promise<DraftOutcome> {
    const repo = this.deps.repo;
    const ctx = await repo.contextForUserCompany(userId, userCompanyId);
    if (!ctx) return { userCompanyId, outcome: 'blocked', reason: 'not_found', message: 'We could not find that company.' };
    const selfServe = ctx.selfServeUrl && !(ctx.mustKeep || ctx.riskLevel === 'must_keep') ? { selfServeUrl: ctx.selfServeUrl } : {};
    const isForm = ctx.grievanceChannel === 'web_form';
    const done = (outcome: 'created' | 'existing', requestId: string | undefined): DraftOutcome => ({
      userCompanyId,
      outcome: isForm ? 'use_form' : outcome,
      ...(requestId ? { requestId } : {}),
      ...(isForm && ctx.grievanceFormUrl ? { formUrl: ctx.grievanceFormUrl, message: useFormMessage(ctx.companyName) } : {}),
      ...selfServe,
    });

    const blocker = companyBlockers(ctx)[0];
    if (blocker) {
      if (blocker.code === 'no_contact' || blocker.code === 'contact_bounced') {
        // Stands in for the admin task of finding the contact (F6-AC4) until the admin module exists.
        await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'company.contact_missing', targetType: 'company', targetId: ctx.companyId, requestId: httpRequestId });
      }
      if (blocker.code === 'kept') return { userCompanyId, outcome: 'kept', message: blocker.message, ...selfServe };
      return { userCompanyId, outcome: 'blocked', reason: blocker.code, message: blocker.message, ...selfServe };
    }

    return repo.transaction(async (tx) => {
      const existing = await tx.findOpenRequest(userCompanyId);
      if (existing) return done('existing', existing.id);
      const created = await tx.insertRequest(userId, userCompanyId, isForm ? 'web_form' : 'email');
      if (!created) {
        const raced = await tx.findOpenRequest(userCompanyId);
        return done('existing', raced?.id);
      }
      const text = renderDraft({ userName: profile.name, userEmail: profile.email, companyName: ctx.companyName, signals: ctx.signals, channel: ctx.grievanceChannel });
      const to = destinationOf(ctx) as string; // contactBlocker guarantees a verified address or form URL
      const hash = hashDraft({ to, subject: text.subject, body: text.body });
      await tx.insertDraft({ requestId: created.id, version: 1, to, subject: text.subject, body: text.body, hash, createdBy: 'template' });
      await tx.insertEvent({ requestId: created.id, type: 'drafted', actorType: 'system', draftHash: hash, payload: { version: 1, createdBy: 'template' } });
      this.log.info({ requestId: created.id }, 'request drafted');
      return done('created', created.id);
    });
  }

  // ---- read ----

  async list(userId: string) {
    const rows = await this.deps.repo.listRequests(userId);
    return rows.map((r) => ({
      id: r.id,
      status: r.status as RequestStatus,
      company: { name: r.companyName, mustKeep: r.mustKeep },
      channel: r.channel,
      outcome: outcomeOfStatus(r.status as RequestStatus),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      sentAt: r.sentAt,
      dueAt: r.dueAt,
    }));
  }

  async get(userId: string, requestId: string): Promise<RequestView> {
    return this.view(this.deps.repo, userId, requestId);
  }

  private async view(r: RequestsTx, userId: string, requestId: string): Promise<RequestView> {
    const req = await r.getRequest(userId, requestId);
    const ctx = req ? await r.contextForRequest(userId, requestId) : undefined;
    const draft = req ? await r.latestDraft(requestId) : undefined;
    if (!req || !ctx || !draft) throw Problems.notFound();
    const events = await r.events(requestId);
    const approved = await r.hasUserApproval(requestId, draft.draftHash, draft.createdAt);

    const blockers: RequestView['blockers'] = draftBlockers(ctx, draft).map((b) => ({
      code: b.code,
      message: b.message,
      ...(b.findings ? { findings: b.findings } : {}),
      ...(typeof b.extra?.formUrl === 'string' ? { formUrl: b.extra.formUrl } : {}),
    }));
    if (this.deps.sender.kind === 'unavailable') blockers.push({ code: this.deps.sender.code, message: this.deps.sender.detail });
    const canSend = req.status === 'approved' && approved && blockers.length === 0;
    const replies = await r.replySummary(req.id);
    const followups = await r.followups(req.id);
    const currentFollowup = followups.filter((f) => f.status !== 'cancelled').at(-1);
    const followupDraft = currentFollowup ? await r.latestFollowupDraft(currentFollowup.id) : undefined;
    const followupApproved = followupDraft ? await r.hasFollowupApproval(req.id, followupDraft.draftHash, followupDraft.createdAt) : false;
    const lastOutcomeEvent = [...events].reverse().find((e) => e.type === 'outcome_set');
    const useForm = ctx.grievanceChannel === 'web_form';
    return {
      request: { id: req.id, status: req.status, channel: req.channel, createdAt: req.createdAt, updatedAt: req.updatedAt, sentAt: req.sentAt, dueAt: req.dueAt },
      company: { id: ctx.companyId, name: ctx.companyName, mustKeep: ctx.mustKeep || ctx.riskLevel === 'must_keep', kept: ctx.keptAt !== null, selfServeUrl: ctx.selfServeUrl },
      contact: { channel: ctx.grievanceChannel, formUrl: ctx.grievanceChannel === 'web_form' ? ctx.grievanceFormUrl : null },
      useForm: ctx.grievanceChannel === 'web_form',
      draft: { version: draft.version, to: draft.toEmail, subject: draft.subject, body: draft.body, hash: draft.draftHash, createdBy: draft.createdBy, createdAt: draft.createdAt },
      approved,
      events: events.map((e: EventRow) => ({ type: e.type, actor: e.actorType, at: e.createdAt, payload: e.payload })),
      canSend,
      blockers,
      replies,
      outcome: outcomeView(req.status, lastOutcomeEvent),
      canSetOutcome: TRACKING_STATUSES.includes(req.status),
      // The form blocker is the very reason to use the form, so it does not count against marking it as submitted.
      canMarkSubmitted: useForm && PRE_SEND_STATUSES.includes(req.status) && draftBlockers(ctx, draft).every((b) => b.code === 'use_form'),
      followup: summariseFollowup({ req, ctx, firstDraft: draft, followups, draft: followupDraft, approved: followupApproved, now: this.now(), settings: this.followupSettings, sender: this.deps.sender }),
    };
  }

  // ---- edit ----

  /**
   * A new draft version (F6-AC2). The earlier approval no longer matches the latest hash, so the request goes back
   * to `drafted` and needs approval again. `baseHash` is the version the person was looking at: if someone else
   * changed it meanwhile the edit is refused instead of overwriting.
   */
  async editDraft(userId: string, requestId: string, input: { baseHash: string; subject: string; body: string }): Promise<RequestView> {
    // ID numbers are refused before anything is stored. The unresolved [OPEN] marker is allowed here: it is what the user edits away.
    const idFindings = findSafetyIssues(input.subject, input.body).filter((f) => ID_FINDINGS.includes(f));
    if (idFindings.length) throw new AppError(422, 'draft_unsafe', titleFor('draft_unsafe'), explainFindings(idFindings), { findings: idFindings });

    return this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req) throw Problems.notFound();
      if (!PRE_SEND_STATUSES.includes(req.status)) {
        throw new AppError(409, 'request_not_editable', 'This request can no longer be edited', `A request that is ${req.status} cannot be edited.`);
      }
      if (await tx.activeSendClaim(req.id)) {
        throw new AppError(409, 'send_in_progress', 'This request is being sent', 'It cannot be edited while it is being sent or after it was sent.');
      }
      const latest = await tx.latestDraft(req.id);
      if (!latest) throw Problems.notFound();
      if (!isDraftHash(input.baseHash) || input.baseHash !== latest.draftHash) {
        throw new AppError(409, 'draft_changed', 'The draft changed', 'Reload the request and edit the latest version.');
      }
      const hash = hashDraft({ to: latest.toEmail, subject: input.subject, body: input.body });
      if (hash === latest.draftHash) return this.view(tx, userId, requestId); // nothing changed: no new version

      const version = latest.version + 1;
      await tx.insertDraft({ requestId: req.id, version, to: latest.toEmail, subject: input.subject, body: input.body, hash, createdBy: 'user' });
      if (req.status === 'approved') {
        assertTransition('approved', 'drafted');
        await tx.setStatus(req.id, 'drafted');
      }
      await tx.insertEvent({ requestId: req.id, type: 'edited', actorType: 'user', actorId: userId, draftHash: hash, payload: { version, previousStatus: req.status } });
      return this.view(tx, userId, requestId);
    });
  }

  // ---- approve ----

  /** Records the user's approval of exactly the draft hash they were shown (F6-AC1). */
  async approve(userId: string, requestId: string, draftHash: string): Promise<RequestView> {
    return this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req) throw Problems.notFound();
      const latest = await tx.latestDraft(req.id);
      const ctx = await tx.contextForRequest(userId, requestId);
      if (!latest || !ctx) throw Problems.notFound();
      assertEmailRequest(ctx);

      if (!isDraftHash(draftHash) || draftHash !== latest.draftHash) {
        throw new AppError(409, 'draft_changed', 'The draft changed', 'The text you approved is not the latest version. Review it again.');
      }
      // Already approved with a valid approval of this exact draft: same answer, nothing to record.
      if (req.status === 'approved' && (await tx.hasUserApproval(req.id, latest.draftHash, latest.createdAt))) {
        return this.view(tx, userId, requestId);
      }
      if (req.status !== 'approved') assertTransition(req.status, 'approved');

      // The guards run on every approval, including one that finds an approved request with no valid approval.
      const blocker = draftBlockers(ctx, latest)[0];
      if (blocker) throwBlocker(blocker);

      await tx.insertEvent({ requestId: req.id, type: 'approved', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { version: latest.version } });
      if (req.status !== 'approved') await tx.setStatus(req.id, 'approved');
      return this.view(tx, userId, requestId);
    });
  }

  // ---- close ----

  async close(userId: string, requestId: string): Promise<RequestView> {
    return this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req) throw Problems.notFound();
      if (!PRE_SEND_STATUSES.includes(req.status)) {
        throw new AppError(409, 'request_not_closable', 'This request cannot be closed here', `A request that is ${req.status} cannot be closed before sending.`);
      }
      if (await tx.activeSendClaim(req.id)) {
        throw new AppError(409, 'send_in_progress', 'This request is being sent', 'It cannot be closed while it is being sent.');
      }
      assertTransition(req.status, 'closed');
      const latest = await tx.latestDraft(req.id);
      await tx.insertEvent({ requestId: req.id, type: 'closed', actorType: 'user', actorId: userId, ...(latest ? { draftHash: latest.draftHash } : {}), payload: { from: req.status } });
      await tx.setStatus(req.id, 'closed');
      return this.view(tx, userId, requestId);
    });
  }

  // ---- outcome and "mark as submitted" (Phase 2) ----

  /**
   * The person reports what the company answered (PRD F7). Nothing infers it: not a reply we found, not its sender, not
   * its wording. It can be set when no reply was detected (the answer may have come by phone or through the form), changed,
   * and taken back to "no answer yet", which returns the request to `sent`, or to `no_reply` once the follow-up day has
   * passed. Setting the same thing again changes nothing and records nothing.
   */
  async setOutcome(userId: string, requestId: string, outcome: OutcomeValue): Promise<RequestView> {
    let changed: { from: RequestStatus; to: RequestStatus } | undefined;
    const view = await this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req) throw Problems.notFound();
      if (!TRACKING_STATUSES.includes(req.status)) {
        throw new AppError(409, 'invalid_transition', 'There is no outcome to report yet', outcomeRefusal(req.status));
      }
      const days = this.deps.followupAfterDays ?? 30;
      const overdue = req.sentAt !== null && this.now().getTime() >= req.sentAt.getTime() + days * 24 * 60 * 60 * 1000;
      const target = statusForOutcome(outcome, overdue);
      // "No answer yet" while already waiting (sent or no_reply) is where the person already is.
      if (target === req.status || (outcome === 'no_answer_yet' && (req.status === 'sent' || req.status === 'no_reply'))) {
        return this.view(tx, userId, requestId);
      }
      assertTransition(req.status, target);
      await tx.insertEvent({ requestId: req.id, type: eventFor(req.status, target), actorType: 'user', actorId: userId, payload: { from: req.status, to: target, outcome } });
      await tx.setStatus(req.id, target);
      changed = { from: req.status, to: target };
      return this.view(tx, userId, requestId);
    });
    if (changed) {
      await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'request.outcome_set', targetType: 'request', targetId: requestId });
      this.log.info({ requestId, from: changed.from, to: changed.to }, 'outcome reported');
    }
    return view;
  }

  /**
   * The person says they pasted the draft into the company's web form. Nothing is sent from here. It is recorded the way
   * a send is: the person approves the exact draft they copied (`draftHash`), the guards run again (a must-keep or kept
   * company, a verified form contact, ID numbers and the unresolved [OPEN] line), and the request becomes `sent`, which
   * starts the clock for a reply. A web form has no Gmail thread, so there is nothing for reply checks to follow: the
   * person reports the outcome. Doing it twice changes nothing.
   */
  async markSubmitted(userId: string, requestId: string, draftHash: string): Promise<RequestView> {
    let recorded = false;
    const view = await this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req) throw Problems.notFound();
      const latest = await tx.latestDraft(req.id);
      const ctx = await tx.contextForRequest(userId, requestId);
      if (!latest || !ctx) throw Problems.notFound();

      if (TRACKING_STATUSES.includes(req.status)) {
        if (req.channel === 'web_form') return this.view(tx, userId, requestId); // already marked
        throw new AppError(409, 'already_sent', 'Already sent', 'This request was already sent by email.');
      }
      if (ctx.grievanceChannel !== 'web_form') {
        throw new AppError(409, 'not_a_form_request', 'This company does not use a web form', `${ctx.companyName} takes requests by email. Review the draft, approve it and send it instead.`);
      }
      if (req.status !== 'approved') assertTransition(req.status, 'approved'); // a closed or bounced request cannot be submitted

      if (!isDraftHash(draftHash) || draftHash !== latest.draftHash) {
        throw new AppError(409, 'draft_changed', 'The draft changed', 'The text you copied is not the latest version. Copy the latest draft before you say you submitted it.');
      }
      const blocker = draftBlockers(ctx, latest).find((b) => b.code !== 'use_form');
      if (blocker) throwBlocker(blocker);

      if (!(await tx.hasUserApproval(req.id, latest.draftHash, latest.createdAt))) {
        await tx.insertEvent({ requestId: req.id, type: 'approved', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { version: latest.version, forForm: true } });
      }
      if (req.status !== 'approved') await tx.setStatus(req.id, 'approved');
      assertTransition('approved', 'sent');
      const sentAt = this.now();
      await tx.markSubmitted(req.id, { sentAt, dueAt: new Date(sentAt.getTime() + THIRTY_DAYS_MS) });
      await tx.insertEvent({ requestId: req.id, type: 'submitted', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { version: latest.version } });
      recorded = true;
      return this.view(tx, userId, requestId);
    });
    if (recorded) {
      await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'request.submitted', targetType: 'request', targetId: requestId });
      this.log.info({ requestId }, 'request marked as submitted to the web form');
    }
    return view;
  }

  // ---- send ----

  /**
   * Sends an approved draft (F6). The rules, in order:
   * 1. the same Idempotency-Key replays the stored answer and never sends twice;
   * 2. only an `approved` request, whose latest draft has a user approval of its exact hash, can be sent
   *    (migration 0002 enforces the same rule again in the database);
   * 3. must-keep, contact, ID-number and placeholder checks run again, so nothing changed since approval slips through;
   * 4. a claim is recorded before the sender is called, so two sends cannot overlap and an edit cannot slip in.
   * An unknown outcome (a timeout) leaves the claim in progress and the request unsent, on purpose.
   */
  async send(userId: string, requestId: string, key: string): Promise<{ status: number; body: SendResponse }> {
    if (this.deps.sender.kind === 'unavailable') {
      throw new AppError(503, this.deps.sender.code, 'Sending is not available', this.deps.sender.detail);
    }
    const sender = this.deps.sender.sender;

    // Phase A: check everything and claim the send, in one transaction holding the request lock.
    const phaseA = await this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req) throw Problems.notFound();

      const prior = await tx.findClaim(userId, 'send', key);
      if (prior) {
        if (prior.requestId !== req.id) {
          throw new AppError(422, 'idempotency_key_reuse', 'Idempotency key already used', 'This key was used for a different request. Use a new key.');
        }
        if (prior.status === 'completed' && prior.response) return { replay: { status: prior.responseStatus ?? 200, body: prior.response as unknown as SendResponse } };
        if (prior.status === 'in_progress') {
          throw new AppError(409, 'send_in_progress', 'This request is being sent', 'A send with this key is already running or its result is unknown. Check the Sent folder in Gmail.');
        }
      }

      // A request that was already sent is unaffected by later changes (keep, must keep, a new contact).
      if (req.status === 'sent') throw new AppError(409, 'already_sent', 'Already sent', 'This request was already sent.');

      // A web-form company cannot be sent by email, whatever state the request is in.
      const formCtx = await tx.contextForRequest(userId, requestId);
      if (!formCtx) throw Problems.notFound();
      assertEmailRequest(formCtx);

      if (req.status !== 'approved') {
        if (req.status === 'drafted') {
          throw new AppError(409, 'approval_required', 'Approval needed', 'Review the draft and approve it before sending. Nothing is sent without your approval.');
        }
        assertTransition(req.status, 'sent');
      }

      const draft = await tx.latestDraft(req.id);
      const ctx = await tx.contextForRequest(userId, requestId);
      if (!draft || !ctx) throw Problems.notFound();

      // The application-level approval guard: a user approval of this exact hash, not older than this draft.
      if (!(await tx.hasUserApproval(req.id, draft.draftHash, draft.createdAt))) {
        throw new AppError(409, 'approval_required', 'Approval needed', 'The latest draft has not been approved. Review it and approve it before sending.');
      }
      const blocker = draftBlockers(ctx, draft)[0];
      if (blocker) throwBlocker(blocker);

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
      else claim = await tx.insertClaim(userId, req.id, key);
      if (!claim) throw new AppError(409, 'send_in_progress', 'This request is being sent', 'Another send for this request is running or finished.');
      return { claim, draft, inbox };
    });
    if (phaseA.replay) return phaseA.replay;

    // Phase B: hand the message to the sender. No transaction is held while waiting on it.
    let sent: SentMessage;
    try {
      sent = await sender.send({
        inboxId: phaseA.inbox.id,
        from: phaseA.inbox.email,
        to: phaseA.draft.toEmail,
        subject: phaseA.draft.subject,
        body: phaseA.draft.body,
        requestId,
      });
    } catch (err) {
      if (err instanceof SenderRejectedError) {
        await this.deps.repo.failClaim(phaseA.claim.id);
        this.log.warn({ requestId, outcome: 'rejected' }, 'send refused by sender');
        throw new AppError(502, 'send_failed', 'The message was not sent', 'Gmail did not accept the message, so nothing was sent. You can try again.');
      }
      this.log.warn({ requestId, outcome: err instanceof SenderOutcomeUnknownError ? 'unknown' : 'error' }, 'send outcome unknown');
      throw new AppError(
        502,
        'send_outcome_unknown',
        'We could not confirm the message was sent',
        'Check the Sent folder in Gmail before doing anything else. Erase.me has not marked this request as sent and will not retry it on its own.',
      );
    }

    // Phase C: mark the request sent, record the event and complete the claim, in one transaction.
    const sentAt = this.now();
    const dueAt = new Date(sentAt.getTime() + THIRTY_DAYS_MS);
    const body: SendResponse = {
      request: { id: requestId, status: 'sent', sentAt: sentAt.toISOString(), dueAt: dueAt.toISOString() },
      delivery: sent.delivery,
      ...(sent.delivery === 'fake' ? { notice: FAKE_NOTICE } : {}),
    };
    try {
      await this.markSent(userId, requestId, phaseA.draft, phaseA.claim, sent, sentAt, dueAt, body);
    } catch {
      // The message went out but recording it failed. Leave the claim in progress so nothing is sent twice.
      this.log.warn({ requestId, outcome: 'unrecorded' }, 'sent but not recorded');
      throw new AppError(
        502,
        'send_outcome_unknown',
        'We could not confirm the message was sent',
        'Check the Sent folder in Gmail before doing anything else. Erase.me has not marked this request as sent and will not retry it on its own.',
      );
    }
    await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'request.sent', targetType: 'request', targetId: requestId });
    this.log.info({ requestId, delivery: sent.delivery }, 'request sent');
    return { status: 200, body };
  }

  private async markSent(userId: string, requestId: string, draft: DraftRow, claim: ClaimRow, sent: SentMessage, sentAt: Date, dueAt: Date, body: SendResponse): Promise<void> {
    await this.deps.repo.transaction(async (tx) => {
      const req = await tx.lockRequest(userId, requestId);
      if (!req || req.status !== 'approved') throw new AppError(409, 'invalid_transition', 'This request cannot move to that state', 'The request changed while it was being sent.');
      assertTransition(req.status, 'sent');
      await tx.markSent(req.id, {
        threadId: sent.threadId,
        sentAt,
        dueAt,
        sentMessageId: sent.messageId,
        ...(sent.rfcMessageId ? { sentRfcMessageId: sent.rfcMessageId } : {}),
      });
      await tx.insertEvent({
        requestId: req.id,
        type: eventFor('approved', 'sent'),
        actorType: 'user',
        actorId: userId,
        draftHash: draft.draftHash,
        payload: { version: draft.version, delivery: sent.delivery },
      });
      await tx.completeClaim(claim.id, 200, body as unknown as Record<string, unknown>);
    });
  }
}

/** Why a request in this status cannot take an outcome. */
function outcomeRefusal(status: RequestStatus): string {
  if (status === 'drafted' || status === 'approved') return 'This request has not been sent yet, so there is nothing to report. Send it, or mark it as submitted if it uses a web form.';
  return `A request that is ${status} cannot take an outcome.`;
}

/** What to show as the outcome of a request in this status, given the last time the person set one. */
function outcomeView(status: RequestStatus, last: EventRow | undefined): RequestView['outcome'] {
  const reported = reportedOutcomeOf(status);
  if (reported) return { value: reported, setByUser: true, at: last?.createdAt ?? null };
  if (isWaiting(status)) return { value: 'no_answer_yet', setByUser: false, at: null };
  if (status === 'closed') {
    // A closed request keeps the last outcome the person reported, if there was one.
    const value = last?.payload.outcome;
    return isReportedOutcome(value) ? { value, setByUser: true, at: last?.createdAt ?? null } : null;
  }
  return null;
}

export const isRequestId = (v: string): boolean => isId('request', v);
export type { RequestRow };
