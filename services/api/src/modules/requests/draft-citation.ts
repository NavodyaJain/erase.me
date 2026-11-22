/**
 * The statute wording used in drafts. The owner verifies it against official sources and then replaces these
 * constants and sets `verified: true` (PRD 13, docs/OPEN-QUESTIONS.md).
 *
 * One flag gates all of it: the erasure citation, the summary citation and the commencement sentence (which
 * carries a date). Until `verified` is true:
 * - drafts carry a visible [OPEN] paragraph instead of that wording, so no section number or date can be sent,
 * - approval and sending refuse any text that still contains the marker,
 * - real sending stays off (see sender selection), whatever ALLOW_REAL_SEND says.
 *
 * Until the rights provisions commence, a draft is a polite request, not a statutory demand. The sentences below
 * say so, and none of them states a legal duty on the company.
 */
export interface StatuteCitation {
  verified: boolean;
  /** The erasure request and the section it refers to. */
  erasureLine: string;
  /** The optional summary-of-data request and the section it refers to. */
  summaryLine: string;
  /** When the rights provisions are notified to commence, and what that means for this message. */
  commencementLine: string;
  /** What the owner has to verify, shown inside the [OPEN] paragraph while unverified. */
  candidate: string;
}

export const STATUTE_CITATION: StatuteCitation = {
  verified: false,
  erasureLine: 'I am asking for erasure with reference to Section 12(3) of the Digital Personal Data Protection Act, 2023.',
  summaryLine: 'My request for a summary refers to Section 11(1) of the Act.',
  commencementLine:
    'I understand the Act’s provisions on the rights of data principals are notified to come into force in May 2027, so I am making this as a request now.',
  candidate:
    'Section 12(3) (erasure) and Section 11(1) (summary of data held) of the Digital Personal Data Protection Act, 2023; rights provisions to commence about 13 May 2027 (18 months from 13 November 2025)',
};

export const OPEN_MARKER = '[OPEN';
