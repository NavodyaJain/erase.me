import { hashDraft } from './draft-hash.js';
import { explainFindings, findSafetyIssues, type SafetyFinding } from './draft-safety.js';
import { FOLLOWUP_WORDING } from './followup-template.js';
import { companyBlockers, destinationOf, type Blocker } from './request-guards.js';
import type { CompanyContext, DraftRow, FollowupRow, RequestRow } from './requests.repository.js';
import type { SenderChoice } from './sender.js';

/** The settings that shape follow-ups (FOLLOWUP_AFTER_DAYS, FOLLOWUP_MAX) and the sign-off of their wording. */
export interface FollowupSettings {
  afterDays: number;
  /** Follow-ups allowed per request. 0 turns them off. */
  max: number;
  /** The owner has read the follow-up wording and signed it off. Until then a real follow-up is refused. */
  wordingSignedOff: boolean;
}

export const DEFAULT_FOLLOWUP_SETTINGS: FollowupSettings = { afterDays: 30, max: 1, wordingSignedOff: FOLLOWUP_WORDING.signedOff };

const DAY_MS = 24 * 60 * 60 * 1000;
export const followupDueAt = (from: Date, afterDays: number): Date => new Date(from.getTime() + afterDays * DAY_MS);

/** A request is still waiting for an answer: no reply has been received and no outcome reported. Only then does a follow-up make sense. */
export const isWaitingForAnswer = (status: RequestRow['status']): boolean => status === 'sent' || status === 'no_reply';

export const REAL_FOLLOWUP_BLOCKED = 'Real follow-ups stay off until the follow-up wording has been read and signed off.';

export type FollowupState = 'none' | 'not_due' | 'due' | 'drafted' | 'approved' | 'sent' | 'submitted';

/** What a request view says about its follow-up. Ids, times, the draft the person reviews and what blocks it: never what a reply said. */
export interface FollowupSummary {
  state: FollowupState;
  /** When a follow-up becomes due, or null when none can be (not sent, or follow-ups are off). */
  dueAt: Date | null;
  /** How many more follow-ups this request may have. */
  remaining: number;
  sequence: number | null;
  sentAt: Date | null;
  draft: { version: number; to: string; subject: string; body: string; hash: string; createdBy: string; createdAt: Date } | null;
  approved: boolean;
  /** "Follow up?" can be offered. */
  canCreate: boolean;
  canSend: boolean;
  /** A web-form follow-up is copy-only: the person says they pasted it into the form. */
  canMarkSubmitted: boolean;
  blockers: Array<{ code: string; message: string; findings?: SafetyFinding[]; formUrl?: string }>;
}

/**
 * The company's contact is no longer the place the first message went: another address, or a different way of taking
 * requests (an email address became a web form, or the other way round). A follow-up would not reach the same place.
 */
export function contactChangedBlocker(ctx: CompanyContext, channel: RequestRow['channel'], firstTo: string): Blocker | null {
  const destination = destinationOf(ctx);
  const channelChanged = (ctx.grievanceChannel === 'web_form') !== (channel === 'web_form');
  if (!channelChanged && (destination === null || firstTo.toLowerCase() === destination.toLowerCase())) return null;
  return { code: 'contact_changed', status: 409, message: `The grievance contact for ${ctx.companyName} changed since the first message was sent. A follow-up would not reach the same place.` };
}

/** What can stop this exact follow-up draft: the first request's rules, and a contact that has changed since the first message. */
export function followupDraftBlockers(ctx: CompanyContext, channel: RequestRow['channel'], firstTo: string, draft: DraftRow): Blocker[] {
  const out = companyBlockers(ctx);
  if (hashDraft({ to: draft.toEmail, subject: draft.subject, body: draft.body }) !== draft.draftHash) {
    out.push({ code: 'draft_integrity', status: 409, message: 'This draft does not match its saved fingerprint. Close this follow-up and start again.' });
  }
  const changed = contactChangedBlocker(ctx, channel, firstTo);
  if (changed) out.push(changed);
  const findings = findSafetyIssues(draft.subject, draft.body);
  if (findings.length) out.push({ code: 'draft_unsafe', status: 422, message: explainFindings(findings), findings });
  return out;
}

export interface FollowupSummaryInput {
  req: RequestRow;
  ctx: CompanyContext;
  /** The first request's draft: the follow-up goes to the same place. */
  firstDraft: DraftRow;
  followups: FollowupRow[];
  /** The current (open, or last finished) follow-up's latest draft, and whether it has a valid approval. */
  draft: DraftRow | undefined;
  approved: boolean;
  now: Date;
  settings: FollowupSettings;
  sender: SenderChoice;
}

export function summariseFollowup(i: FollowupSummaryInput): FollowupSummary {
  const { req, ctx, followups, settings } = i;
  const live = followups.filter((f) => f.status !== 'cancelled');
  const remaining = Math.max(0, settings.max - live.length);
  const current = live.at(-1);
  const open = current && (current.status === 'drafted' || current.status === 'approved') ? current : undefined;
  const done = current && (current.status === 'sent' || current.status === 'submitted') ? current : undefined;
  const waiting = isWaitingForAnswer(req.status);

  const from = done?.sentAt ?? req.sentAt;
  const dueAt = req.sentAt && settings.max > 0 && from ? followupDueAt(from, settings.afterDays) : null;

  let state: FollowupState;
  if (open && waiting) state = open.status as 'drafted' | 'approved';
  else if (done && remaining === 0) state = done.status as 'sent' | 'submitted';
  else if (!waiting || settings.max <= 0 || remaining <= 0 || !dueAt) state = 'none';
  else state = i.now.getTime() >= dueAt.getTime() ? 'due' : 'not_due';

  const shown = state === 'drafted' || state === 'approved' || state === 'sent' || state === 'submitted' ? i.draft : undefined;
  const isForm = req.channel === 'web_form';

  let blockers: Blocker[] = [];
  if (state === 'due') {
    blockers = companyBlockers(ctx);
    const changed = contactChangedBlocker(ctx, req.channel, i.firstDraft.toEmail);
    if (changed) blockers.push(changed);
  }
  if ((state === 'drafted' || state === 'approved') && i.draft) blockers = followupDraftBlockers(ctx, req.channel, i.firstDraft.toEmail, i.draft);
  const extra: FollowupSummary['blockers'] = [];
  if (!isForm && (state === 'drafted' || state === 'approved')) {
    if (i.sender.kind === 'unavailable') extra.push({ code: i.sender.code, message: i.sender.detail });
    else if (i.sender.sender.mode === 'real' && !settings.wordingSignedOff) extra.push({ code: 'real_send_blocked', message: REAL_FOLLOWUP_BLOCKED });
  }
  const listed: FollowupSummary['blockers'] = [
    ...blockers.map((b) => ({ code: b.code, message: b.message, ...(b.findings ? { findings: b.findings } : {}), ...(typeof b.extra?.formUrl === 'string' ? { formUrl: b.extra.formUrl } : {}) })),
    ...extra,
  ];

  const draftReady = (state === 'drafted' || state === 'approved') && blockers.length === 0;
  return {
    state,
    dueAt,
    remaining,
    sequence: current?.sequence ?? null,
    sentAt: done?.sentAt ?? null,
    draft: shown ? { version: shown.version, to: shown.toEmail, subject: shown.subject, body: shown.body, hash: shown.draftHash, createdBy: shown.createdBy, createdAt: shown.createdAt } : null,
    approved: state === 'approved' && i.approved,
    canCreate: state === 'due' && blockers.length === 0,
    canSend: !isForm && state === 'approved' && i.approved && draftReady && extra.length === 0,
    canMarkSubmitted: isForm && draftReady,
    blockers: listed,
  };
}
