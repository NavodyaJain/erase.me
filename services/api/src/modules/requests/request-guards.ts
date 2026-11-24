import { AppError } from '../../common/errors.js';
import { hashDraft } from './draft-hash.js';
import { explainFindings, findSafetyIssues, type SafetyFinding } from './draft-safety.js';
import type { CompanyContext, DraftRow } from './requests.repository.js';

/**
 * The rules that stop a request from moving forward, in one place so the first request and its follow-up are held to the
 * same ones: a company the person marked as not theirs, a must-keep company, one they chose to keep, no verified contact,
 * a contact that bounced or changed, a draft that no longer matches its fingerprint, and a draft with an ID-like number or
 * an unresolved [OPEN] line.
 */
/** Something that stops a request from being drafted, approved or sent, with words a person can act on. */
export interface Blocker {
  code: 'company_excluded' | 'must_keep' | 'kept' | 'no_contact' | 'contact_bounced' | 'contact_changed' | 'use_form' | 'draft_integrity' | 'draft_unsafe';
  status: number;
  message: string;
  findings?: SafetyFinding[];
  /** Extra fields for the error and the view, for example the form link. */
  extra?: Record<string, unknown>;
}

export const mustKeepMessage = (company: string): string =>
  `${company} is needed to keep your account working, so Erase.me does not offer a deletion request for it. If you stop using it, you can close the account with the company directly.`;
export const keptMessage = (company: string): string =>
  `You chose to keep ${company}, so Erase.me makes no request for it. Undo "keep" to continue.`;
export const noContactMessage = (company: string): string =>
  `We do not have a verified grievance contact for ${company} yet, so this request is blocked. We have noted it so the contact can be found. Nothing is sent without one.`;
export const bouncedMessage = (company: string): string =>
  `The grievance contact we have for ${company} did not accept earlier mail, so this request is blocked until the contact is checked.`;

export const useFormMessage = (company: string): string =>
  `${company} takes requests through a web form, so Erase.me cannot send this by email. Copy the draft into the form. It is shown here for that.`;

const isExampleAddress = (email: string): boolean => /@example\.com$/i.test(email);
const isExampleUrl = (url: string): boolean => /^https:\/\/([a-z0-9-]+\.)*example\.com(\/|$)/i.test(url);

/** Where the draft goes: the verified address, or the form URL for a web-form company. Stored in the draft's `to_email`. */
export const destinationOf = (c: CompanyContext): string | null => (c.grievanceChannel === 'web_form' ? c.grievanceFormUrl : c.grievanceEmail);

/**
 * The contact must be verified: an address (or a form), the page it came from and the date it was checked.
 * Fictional entries use example.com only, real ones never do.
 */
export function contactBlocker(c: CompanyContext): Blocker | null {
  if (c.grievanceStatus === 'bounced') return { code: 'contact_bounced', status: 409, message: bouncedMessage(c.companyName) };
  const destination = destinationOf(c);
  const onExample = destination === null ? false : c.grievanceChannel === 'web_form' ? isExampleUrl(destination) : isExampleAddress(destination);
  const verified =
    c.grievanceStatus === 'verified' &&
    destination !== null &&
    c.grievanceSource !== null &&
    c.grievanceVerifiedOn !== null &&
    (c.isFictional ? onExample : !onExample);
  return verified ? null : { code: 'no_contact', status: 409, message: noContactMessage(c.companyName) };
}

/** A web-form company cannot be reached by email: approving or sending stops, and the form link is given instead. */
export function formBlocker(c: CompanyContext): Blocker | null {
  if (c.grievanceChannel !== 'web_form' || c.grievanceFormUrl === null) return null;
  return { code: 'use_form', status: 409, message: useFormMessage(c.companyName), extra: { formUrl: c.grievanceFormUrl, ...(c.selfServeUrl ? { selfServeUrl: c.selfServeUrl } : {}) } };
}

/** Company-level reasons a request must not move forward. */
export function companyBlockers(c: CompanyContext): Blocker[] {
  const out: Blocker[] = [];
  if (c.userCompanyStatus === 'not_mine') {
    out.push({ code: 'company_excluded', status: 409, message: `You marked ${c.companyName} as not yours, so no request can be made for it.` });
  }
  if (c.mustKeep || c.riskLevel === 'must_keep') out.push({ code: 'must_keep', status: 409, message: mustKeepMessage(c.companyName) });
  // The user's own choice, checked at create, approve and send. Clearing it lets the request go on. Editing and closing still work.
  if (c.keptAt !== null) out.push({ code: 'kept', status: 409, message: keptMessage(c.companyName) });
  const contact = contactBlocker(c);
  if (contact) out.push(contact);
  return out;
}

/** Everything that can block this exact draft. The same list drives the "can send" flag and the errors. */
export function draftBlockers(c: CompanyContext, d: DraftRow): Blocker[] {
  const out = companyBlockers(c);
  const form = formBlocker(c);
  if (form) out.push(form);
  if (hashDraft({ to: d.toEmail, subject: d.subject, body: d.body }) !== d.draftHash) {
    out.push({ code: 'draft_integrity', status: 409, message: 'This draft does not match its saved fingerprint. Create a new request.' });
  }
  const destination = destinationOf(c);
  if (destination !== null && d.toEmail.toLowerCase() !== destination.toLowerCase()) {
    out.push({ code: 'contact_changed', status: 409, message: `The grievance contact for ${c.companyName} changed since this draft was made. Close this request and create a new one.` });
  }
  const findings = findSafetyIssues(d.subject, d.body);
  if (findings.length) out.push({ code: 'draft_unsafe', status: 422, message: explainFindings(findings), findings });
  return out;
}

export const throwBlocker = (b: Blocker): never => {
  throw new AppError(b.status, b.code, titleFor(b.code), b.message, { ...(b.findings ? { findings: b.findings } : {}), ...(b.extra ?? {}) });
};

export function titleFor(code: Blocker['code']): string {
  switch (code) {
    case 'must_keep':
      return 'No deletion request is offered for this company';
    case 'no_contact':
    case 'contact_bounced':
      return 'No verified contact for this company';
    case 'company_excluded':
      return 'Company excluded';
    case 'kept':
      return 'You chose to keep this company';
    case 'use_form':
      return 'Use the company\u2019s web form';
    case 'draft_unsafe':
      return 'The draft cannot be used yet';
    default:
      return 'The request cannot move forward';
  }
}

/** Company-level blockers first (must keep, no contact), then the web-form stop with the link. */
export function assertEmailRequest(c: CompanyContext): void {
  const blocker = companyBlockers(c)[0] ?? formBlocker(c);
  if (blocker) throwBlocker(blocker);
}
