/**
 * The statute citation used in drafts. The owner verifies the wording against official sources and then
 * replaces this constant (PRD 13, docs/OPEN-QUESTIONS.md). Until `verified` is true:
 * - drafts carry a visible [OPEN] marker instead of the citation,
 * - approval and sending refuse any text that still contains that marker,
 * - real sending stays off (see sender selection), whatever ALLOW_REAL_SEND says.
 */
export interface StatuteCitation {
  verified: boolean;
  /** The sentence used in the draft once verified. */
  line: string;
  /** Shown to the owner inside the [OPEN] marker while unverified. */
  candidate: string;
}

export const STATUTE_CITATION: StatuteCitation = {
  verified: false,
  line: 'I am making this request under Section 12 of the Digital Personal Data Protection Act, 2023.',
  candidate: 'Section 12, Digital Personal Data Protection Act, 2023',
};

export const OPEN_MARKER = '[OPEN';
