// banned-words:ignore-file  (this file names the words and phrases that must never appear in a draft)

/** Shared by the tests of the first request and of the follow-up: the rendered text is held to the same rules. */
/** Phrases that would turn a polite request into a legal demand, a threat or a claim about a duty. */
export const LEGAL_DEMAND_PHRASES: Array<[string, RegExp]> = [
  ['you must', /\byou must\b/i],
  ['you are required / legally required', /\b(you are|is|are) (legally )?(required|obliged|bound|liable)\b|\blegally (required|obliged|bound)\b/i],
  ['obliged / obligation / mandatory', /\bobliged\b|\bobligation\b|\bmandatory\b|\bcompulsory\b/i],
  ['a deadline or ultimatum', /\bdeadline\b|\bfailing which\b|\bfailure to\b|\bif you do not\b|\botherwise\b|\bno later than\b|\bat the latest\b|\bwithin 30 days or\b/i],
  ['threats and consequences', /\blegal action\b|\blegal notice\b|\bprosecut|\bpenalt|\bcourt\b|\btribunal\b|\bsue\b|\bfine\b|\bcomplaint to\b|\bescalate\b/i],
  ['accusations', /\bviolat|\bbreach|\bunlawful|\billegal|\bnon-?complian|\bin contravention\b/i],
  ['demanding language', /\bdemand/i],
  ['compliance language', /\bcomply\b|\bcompliance\b/i],
  ['claims about the law or outcome', /\bthe law (says|requires)\b|\bstatutory (right|duty|obligation)\b|\bunder the law\b|\byou will\b|\bwe will\b/i],
];

/** PRD 4.4 words that never appear in product text. The repo lint checks the source; this checks the rendered text. */
export const BANNED_WORDS = /will\s+(be\s+)?delete|guaranteed|non-?compliant|\bcompliant\b|\bviolating\b|\billegal\b|your data is safe|\bleaked\b/i; // banned-words:ignore - the list of banned words itself
