import { AppError, Problems } from '../../common/errors.js';
import { isId } from '../../common/ids.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { InboxService } from '../gmail/inbox.service.js';
import { hashDraft, isDraftHash } from './draft-hash.js';
import { explainFindings, findSafetyIssues, ID_FINDINGS, type SafetyFinding } from './draft-safety.js';
import { renderDraft } from './draft-template.js';
import type { ClaimRow, CompanyContext, DraftRow, EventRow, RequestRow, RequestsRepository, RequestsTx } from './requests.repository.js';
import { SenderOutcomeUnknownError, SenderRejectedError, type SenderChoice, type SentMessage } from './sender.js';
import { assertTransition, eventFor, PRE_SEND_STATUSES, type RequestStatus } from './state-machine.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DRAFTS_PER_CALL = 10;

/** Something that stops a request from being drafted, approved or sent, with words a person can act on. */
export interface Blocker {
  code: 'company_excluded' | 'must_keep' | 'no_contact' | 'contact_bounced' | 'contact_changed' | 'draft_integrity' | 'draft_unsafe';
  status: number;
  message: string;
  findings?: SafetyFinding[];
}

export const mustKeepMessage = (company: string): string =>
  `${company} is needed to keep your account working, so Erase.me does not offer a deletion request for it. If you stop using it, you can close the account with the company directly.`;
const noContactMessage = (company: string): string =>
  `We do not have a verified grievance contact for ${company} yet, so this request is blocked. We have noted it so the contact can be found. Nothing is sent without one.`;
const bouncedMessage = (company: string): string =>
  `The grievance contact we have for ${company} did not accept earlier mail, so this request is blocked until the contact is checked.`;

const isExampleAddress = (email: string): boolean => /@example\.com$/i.test(email);

/** The contact must be verified: an address, the page it came from and the date it was checked. Fictional ones are @example.com only. */
function contactBlocker(c: CompanyContext): Blocker | null {
  if (c.grievanceStatus === 'bounced') return { code: 'contact_bounced', status: 409, message: bouncedMessage(c.companyName) };
  const verified =
    c.grievanceStatus === 'verified' &&
    c.grievanceEmail !== null &&
    c.grievanceSource !== null &&
    c.grievanceVerifiedOn !== null &&
    (c.isFictional ? isExampleAddress(c.grievanceEmail) : !isExampleAddress(c.grievanceEmail));
  return verified ? null : { code: 'no_contact', status: 409, message: noContactMessage(c.companyName) };
}

/** Company-level reasons a request must not move forward. */
function companyBlockers(c: CompanyContext): Blocker[] {
  const out: Blocker[] = [];
  if (c.userCompanyStatus === 'not_mine') {
    out.push({ code: 'company_excluded', status: 409, message: `You marked ${c.companyName} as not yours, so no request can be made for it.` });
  }
  if (c.mustKeep || c.riskLevel === 'must_keep') out.push({ code: 'must_keep', status: 409, message: mustKeepMessage(c.companyName) });
  const contact = contactBlocker(c);
  if (contact) out.push(contact);
  return out;
}

/** Everything that can block this exact draft. The same list drives the "can send" flag and the errors. */
export function draftBlockers(c: CompanyContext, d: DraftRow): Blocker[] {
  const out = companyBlockers(c);
  if (hashDraft({ to: d.toEmail, subject: d.subject, body: d.body }) !== d.draftHash) {
    out.push({ code: 'draft_integrity', status: 409, message: 'This draft does not match its saved fingerprint. Create a new request.' });
  }
  if (c.grievanceEmail !== null && d.toEmail.toLowerCase() !== c.grievanceEmail.toLowerCase()) {
    out.push({ code: 'contact_changed', status: 409, message: `The grievance contact for ${c.companyName} changed since this draft was made. Close this request and create a new one.` });
  }
  const findings = findSafetyIssues(d.subject, d.body);
  if (findings.length) out.push({ code: 'draft_unsafe', status: 422, message: explainFindings(findings), findings });
  return out;
}

const throwBlocker = (b: Blocker): never => {
  throw new AppError(b.status, b.code, titleFor(b.code), b.message, b.findings ? { findings: b.findings } : {});
};

function titleFor(code: Blocker['code']): string {
  switch (code) {
    case 'must_keep':
      return 'No deletion request is offered for this company';
    case 'no_contact':
    case 'contact_bounced':
      return 'No verified contact for this company';
    case 'company_excluded':
      return 'Company excluded';
    case 'draft_unsafe':
      return 'The draft cannot be used yet';
    default:
      return 'The request cannot move forward';
  }
}

export interface DraftOutcome {
  userCompanyId: string;
  outcome: 'created' | 'existing' | 'blocked';
  requestId?: string;
  reason?: Blocker['code'] | 'not_found';
  message?: string;
}

export interface RequestView {
  request: { id: string; status: RequestStatus; createdAt: Date; updatedAt: Date; sentAt: Date | null; dueAt: Date | null };
  company: { id: string; name: string; mustKeep: boolean };
  draft: { version: number; to: string; subject: string; body: string; hash: string; createdBy: string; createdAt: Date };
  approved: boolean;
  events: Array<{ type: string; actor: string; at: Date; payload: Record<string, unknown> }>;
  canSend: boolean;
  blockers: Array<{ code: string; message: string; findings?: SafetyFinding[] }>;
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
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

const FAKE_NOTICE = 'No email was sent. This is a development send to the fake sender.';

export class RequestsService {
  private readonly now: () => Date;
  private readonly log: NonNullable<RequestsServiceDeps['log']>;

  constructor(private readonly deps: RequestsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
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

    const blocker = companyBlockers(ctx)[0];
    if (blocker) {
      if (blocker.code === 'no_contact' || blocker.code === 'contact_bounced') {
        // Stands in for the admin task of finding the contact (F6-AC4) until the admin module exists.
        await this.deps.audit.record({ actorType: 'user', actorId: userId, action: 'company.contact_missing', targetType: 'company', targetId: ctx.companyId, requestId: httpRequestId });
      }
      return { userCompanyId, outcome: 'blocked', reason: blocker.code, message: blocker.message };
    }

    return repo.transaction(async (tx) => {
      const existing = await tx.findOpenRequest(userCompanyId);
      if (existing) return { userCompanyId, outcome: 'existing' as const, requestId: existing.id };
      const created = await tx.insertRequest(userId, userCompanyId);
      if (!created) {
        const raced = await tx.findOpenRequest(userCompanyId);
        return { userCompanyId, outcome: 'existing' as const, ...(raced ? { requestId: raced.id } : {}) };
      }
      const text = renderDraft({ userName: profile.name, userEmail: profile.email, companyName: ctx.companyName, signals: ctx.signals });
      const to = ctx.grievanceEmail as string; // contactBlocker guarantees a verified address
      const hash = hashDraft({ to, subject: text.subject, body: text.body });
      await tx.insertDraft({ requestId: created.id, version: 1, to, subject: text.subject, body: text.body, hash, createdBy: 'template' });
      await tx.insertEvent({ requestId: created.id, type: 'drafted', actorType: 'system', draftHash: hash, payload: { version: 1, createdBy: 'template' } });
      this.log.info({ requestId: created.id }, 'request drafted');
      return { userCompanyId, outcome: 'created' as const, requestId: created.id };
    });
  }

  // ---- read ----

  async list(userId: string) {
    const rows = await this.deps.repo.listRequests(userId);
    return rows.map((r) => ({
      id: r.id,
      status: r.status as RequestStatus,
      company: { name: r.companyName, mustKeep: r.mustKeep },
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

    const blockers: RequestView['blockers'] = draftBlockers(ctx, draft).map((b) => ({ code: b.code, message: b.message, ...(b.findings ? { findings: b.findings } : {}) }));
    if (this.deps.sender.kind === 'unavailable') blockers.push({ code: this.deps.sender.code, message: this.deps.sender.detail });
    const canSend = req.status === 'approved' && approved && blockers.length === 0;
    return {
      request: { id: req.id, status: req.status, createdAt: req.createdAt, updatedAt: req.updatedAt, sentAt: req.sentAt, dueAt: req.dueAt },
      company: { id: ctx.companyId, name: ctx.companyName, mustKeep: ctx.mustKeep || ctx.riskLevel === 'must_keep' },
      draft: { version: draft.version, to: draft.toEmail, subject: draft.subject, body: draft.body, hash: draft.draftHash, createdBy: draft.createdBy, createdAt: draft.createdAt },
      approved,
      events: events.map((e: EventRow) => ({ type: e.type, actor: e.actorType, at: e.createdAt, payload: e.payload })),
      canSend,
      blockers,
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

      if (!isDraftHash(draftHash) || draftHash !== latest.draftHash) {
        throw new AppError(409, 'draft_changed', 'The draft changed', 'The text you approved is not the latest version. Review it again.');
      }
      if (req.status === 'approved') return this.view(tx, userId, requestId); // already approved: same answer
      assertTransition(req.status, 'approved');

      const blocker = draftBlockers(ctx, latest)[0];
      if (blocker) throwBlocker(blocker);

      await tx.insertEvent({ requestId: req.id, type: 'approved', actorType: 'user', actorId: userId, draftHash: latest.draftHash, payload: { version: latest.version } });
      await tx.setStatus(req.id, 'approved');
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

      if (req.status === 'sent') throw new AppError(409, 'already_sent', 'Already sent', 'This request was already sent.');
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
      await tx.markSent(req.id, { threadId: sent.threadId, sentAt, dueAt });
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

export const isRequestId = (v: string): boolean => isId('request', v);
export type { RequestRow };
