import { confidenceFor } from '../gmail/detection-rules.js';
import { STATUTE_CITATION, type StatuteCitation } from './draft-citation.js';

export interface DraftInput {
  userName: string;
  userEmail: string;
  companyName: string;
  /** Signal names the scan recorded for this company. Used only to word what the company likely holds. */
  signals: readonly string[];
}

export interface RenderedDraft {
  subject: string;
  body: string;
}

export const SUBJECT = 'Request to erase my personal data';

/** No line breaks or control characters in values that go into the header lines or the greeting. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What the company likely holds, in plain words, from the kinds of mail it sent. Hedged by the caller. */
function holdsPhrases(signals: readonly string[]): string {
  const phrases: string[] = [];
  if (signals.some((s) => ['welcome', 'receipt', 'transactional', 'verify'].includes(s))) {
    phrases.push('an account or purchase record');
  }
  if (signals.some((s) => s === 'list_unsubscribe' || s === 'newsletter')) {
    phrases.push('my email address on a mailing list');
  }
  return phrases.length ? phrases.join(' and ') : 'my email address';
}

/**
 * The first draft of an erasure request (F6, TRD 7.5): plain and polite, specific, mentions the user's name and
 * registered email, asks for written confirmation within 30 days, and never includes an ID number, a threat or a
 * claim about the outcome. Wording follows PRD 4.4: "likely holds" or "may hold", never a promise or a conclusion.
 * No AI is involved; this is a fixed template.
 *
 * The statute line comes from `citation`. While it is unverified the draft carries an [OPEN] marker that approval
 * and sending refuse (see draft-safety), so an unchecked citation cannot be sent by accident.
 * For the owner's legal review before real use.
 */
export function renderDraft(input: DraftInput, citation: StatuteCitation = STATUTE_CITATION): RenderedDraft {
  const name = oneLine(input.userName) || 'Erase.me user';
  const email = oneLine(input.userEmail);
  const company = oneLine(input.companyName);
  const hedge = confidenceFor(input.signals) === 'high' ? 'likely holds' : 'may hold';
  const citationLine = citation.verified
    ? citation.line
    : `[OPEN: statute citation pending verification. Candidate: ${citation.candidate}. Replace this line with the verified wording before approving.]`;

  const body = [
    `To the Grievance Officer, ${company}`,
    '',
    `I am writing about personal data that ${company} ${hedge} about me.`,
    '',
    'My details',
    `Name: ${name}`,
    `Email address: ${email}`,
    '',
    'What I think you hold',
    `From emails that ${company} sent to this address, I think you ${hedge} ${holdsPhrases(input.signals)}.`,
    '',
    'My request',
    `I ask ${company} to erase the personal data it holds about me. Please reply in writing within 30 days to tell me:`,
    '1. whether the data has been erased;',
    '2. if you keep any of it, what you keep, why, and for how long; and',
    '3. if you need anything from me to confirm who I am, what you need.',
    '',
    citationLine,
    '',
    'I am sending this from the email address above. Please reply to it.',
    '',
    'Thank you.',
    name,
  ].join('\n');

  return { subject: SUBJECT, body };
}
