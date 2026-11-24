import { confidenceFor } from '../gmail/detection-rules.js';
import { STATUTE_CITATION, type StatuteCitation } from './draft-citation.js';

export interface DraftInput {
  userName: string;
  userEmail: string;
  companyName: string;
  /** Signal names the scan recorded for this company. Used only to word what the company likely holds. */
  signals: readonly string[];
  /** How the draft will reach the company. A web form changes only the closing line. Default email. */
  channel?: 'email' | 'web_form';
}

export interface RenderedDraft {
  subject: string;
  body: string;
}

export const SUBJECT = 'Request to erase my personal data';

/** No line breaks or control characters in values that go into the header lines or the greeting. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What the company likely holds, in plain words, from the kinds of mail it sent. Hedged by the caller. */
export function holdsPhrases(signals: readonly string[]): string {
  const phrases: string[] = [];
  if (signals.some((s) => ['welcome', 'receipt', 'transactional', 'verify'].includes(s))) {
    phrases.push('an account or purchase record');
  }
  if (signals.some((s) => s === 'list_unsubscribe' || s === 'newsletter')) {
    phrases.push('my email address on a mailing list');
  }
  return phrases.length ? phrases.join(' and ') : 'my email address';
}

/** The statute wording as one paragraph, or the [OPEN] paragraph that stands in for it until it is verified. */
export function statuteParagraph(c: StatuteCitation): string {
  if (!c.verified) {
    return `[OPEN: statute citation and commencement date pending verification. To verify: ${c.candidate}. Replace this paragraph with the verified wording before approving.]`;
  }
  return [c.erasureLine, c.summaryLine, c.commencementLine].join(' ');
}

/**
 * The first draft of an erasure request (F6, TRD 7.5): a plain, polite request. It is not a legal demand: until the
 * rights provisions commence there is no duty to point to, and even after, this text only asks. It mentions the
 * user's name and registered email, asks for erasure and, as an optional extra, a short summary of the data held,
 * and says it is also made under any erasure process in the company's own privacy policy. "Within 30 days" is a
 * hope ("I would be grateful for..."), never a deadline, and nothing here threatens, accuses or claims an outcome.
 * No ID number is ever included. Wording follows PRD 4.4: "likely holds" or "may hold", never a promise or a
 * conclusion. No AI is involved; this is a fixed template, for the owner's legal review before real use.
 *
 * The statute wording (section numbers and the commencement date) comes from `citation`. While it is unverified the
 * draft carries an [OPEN] paragraph that approval and sending refuse (see draft-safety), so an unchecked citation or
 * date cannot be sent by accident.
 */
export function renderDraft(input: DraftInput, citation: StatuteCitation = STATUTE_CITATION): RenderedDraft {
  const name = oneLine(input.userName) || 'Erase.me user';
  const email = oneLine(input.userEmail);
  const company = oneLine(input.companyName);
  const hedge = confidenceFor(input.signals) === 'high' ? 'likely holds' : 'may hold';

  const body = [
    `To the Grievance Officer, ${company}`,
    '',
    `I am writing to ask about personal data that ${company} ${hedge} about me.`,
    '',
    'My details',
    `Name: ${name}`,
    `Email address: ${email}`,
    '',
    'What I think you hold',
    `From emails that ${company} sent to this address, I think you ${hedge} ${holdsPhrases(input.signals)}.`,
    '',
    'My request',
    `I would like to ask ${company} to erase the personal data it holds about me. I would be grateful for a written reply within 30 days that tells me:`,
    '1. whether the data has been erased;',
    '2. if you keep any of it, what you keep, why, and for how long; and',
    '3. if you need anything from me to confirm who I am, what you need.',
    '',
    'If you can, I would also appreciate a short summary of the personal data you hold about me.',
    '',
    statuteParagraph(citation),
    '',
    'I am also making this request under any erasure process described in your privacy policy.',
    '',
    input.channel === 'web_form'
      ? 'I am submitting this through your web form. Please reply to the email address above.'
      : 'I am sending this from the email address above. Please reply to it.',
    '',
    'Thank you.',
    name,
  ].join('\n');

  return { subject: SUBJECT, body };
}
