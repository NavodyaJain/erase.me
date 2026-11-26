import { confidenceFor } from '../gmail/detection-rules.js';
import { STATUTE_CITATION, type StatuteCitation } from './draft-citation.js';
import { oneLine, statuteParagraph, SUBJECT } from './draft-template.js';

/**
 * The follow-up wording needs the owner's sign-off before it can go out for real, like the statute wording does. Until
 * `signedOff` is true a real follow-up is refused (503 `real_send_blocked`); in development and tests the fake sender
 * labels every follow-up as not sent. The owner flips this after reading the wording below, as with
 * `STATUTE_CITATION.verified`. It is a plain constant on purpose: nothing in the environment can switch it on.
 */
export const FOLLOWUP_WORDING = { signedOff: false } as const;

export interface FollowupInput {
  userName: string;
  userEmail: string;
  companyName: string;
  /** Signal names the scan recorded for this company, only to word what the company likely holds. */
  signals: readonly string[];
  /** When the first request was sent (or marked as submitted). Shown as a date. */
  sentAt: Date;
  /** `web_form`: the person pastes this into the company's form. Nothing is sent from Erase.me. */
  channel?: 'email' | 'web_form';
}

export interface RenderedFollowup {
  subject: string;
  body: string;
}

/** "Re:" so a reply in Gmail stays in the same conversation as the first message. */
export const FOLLOWUP_SUBJECT = `Re: ${SUBJECT}`;

const dateLabel = (d: Date): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);

/**
 * The follow-up to a request that has had no reply (PRD F7). A polite, hedged note, drafted from a fixed template with
 * no AI. What it deliberately does not do:
 * - claim a legal deadline was missed, or that any time has run out: it says only that no reply has been seen yet, and
 *   that a message can go astray;
 * - say what the company will do, or judge whether it has met any duty: it asks, and offers to help with identification;
 * - repeat the "within 30 days" hope of the first message, or put any pressure on the company;
 * - include any ID number.
 * The statute paragraph is the same one the first request uses, and it stays behind `citation.verified`: while it is
 * unverified the draft carries the [OPEN] paragraph, which approval and sending refuse (see draft-safety).
 */
export function renderFollowup(input: FollowupInput, citation: StatuteCitation = STATUTE_CITATION): RenderedFollowup {
  const name = oneLine(input.userName) || 'Erase.me user';
  const email = oneLine(input.userEmail);
  const company = oneLine(input.companyName);
  const hedge = confidenceFor(input.signals) === 'high' ? 'likely holds' : 'may hold';
  const form = input.channel === 'web_form';
  const first = form ? `my request through your web form on ${dateLabel(input.sentAt)}` : `my email of ${dateLabel(input.sentAt)}`;

  const body = [
    `To the Grievance Officer, ${company}`,
    '',
    `I am following up on ${first}, in which I asked about personal data that ${company} ${hedge} about me. I have not seen a reply yet. Messages can go astray, so I am writing again in case it did not reach the right person.`,
    '',
    'My details',
    `Name: ${name}`,
    `Email address: ${email}`,
    '',
    'My request',
    `My request is the same as before: I would like to ask ${company} to erase the personal data it holds about me. I would be grateful for a reply, even a short one, that tells me:`,
    '1. whether you received my first message;',
    '2. whether the data has been erased, or when you expect to be able to tell me; and',
    '3. if you need anything from me to confirm who I am, what you need.',
    '',
    'If you have already replied, thank you. Please point me to your answer, as I may have missed it.',
    '',
    statuteParagraph({ ...citation, summaryLine: citation.followupSummaryLine }),
    '',
    'I am also making this request under any erasure process described in your privacy policy.',
    '',
    form ? 'I am submitting this through your web form. Please reply to the email address above.' : 'I am sending this from the email address above. Please reply to it.',
    '',
    'Thank you for your time.',
    name,
  ].join('\n');

  return { subject: FOLLOWUP_SUBJECT, body };
}
