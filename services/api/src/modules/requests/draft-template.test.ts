import { describe, expect, it } from 'vitest';
import { STATUTE_CITATION } from './draft-citation.js';
import { hashDraft, isDraftHash } from './draft-hash.js';
import { findSafetyIssues } from './draft-safety.js';
import { renderDraft, SUBJECT } from './draft-template.js';

const input = { userName: 'Asha Rao', userEmail: 'asha@example.test', companyName: 'Sample Shop', signals: ['welcome', 'list_unsubscribe'] };
const verified = { ...STATUTE_CITATION, verified: true };

/** Phrases that would turn a polite request into a legal demand, a threat or a claim about a duty. */
const LEGAL_DEMAND_PHRASES: Array<[string, RegExp]> = [
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
const BANNED_WORDS = /will\s+(be\s+)?delete|guaranteed|non-?compliant|\bcompliant\b|\bviolating\b|\billegal\b|your data is safe|\bleaked\b/i; // banned-words:ignore - the list of banned words itself

describe('renderDraft', () => {
  const d = renderDraft(input);

  it('names the user and registered email, and asks for a written reply', () => {
    expect(d.subject).toBe(SUBJECT);
    expect(d.body).toContain('Name: Asha Rao');
    expect(d.body).toContain('Email address: asha@example.test');
    expect(d.body).toMatch(/what you keep, why, and for how long/);
  });

  it('reads as a request: "would like to ask", "would be grateful", never a deadline', () => {
    expect(d.body).toMatch(/I would like to ask Sample Shop to erase/);
    expect(d.body).toMatch(/I would be grateful for a written reply within 30 days/);
    expect(d.body).not.toMatch(/(?<!I would be grateful for a written reply )within 30 days/);
    expect(d.body).not.toMatch(/\bPlease reply in writing within 30 days\b/);
  });

  it('asks for a short summary of the data held, as an optional extra', () => {
    expect(d.body).toMatch(/If you can, I would also appreciate a short summary of the personal data you hold about me\./);
  });

  it('says the request is also made under the company\'s own privacy policy, generically', () => {
    expect(d.body).toContain('I am also making this request under any erasure process described in your privacy policy.');
  });

  it('uses hedged wording (PRD 4.4)', () => {
    expect(d.body).toMatch(/likely holds/);
    const low = renderDraft({ ...input, signals: ['newsletter'] });
    expect(low.body).toMatch(/may hold/);
    expect(low.body).not.toMatch(/likely holds/);
    expect(low.body).toContain('my email address on a mailing list');
  });

  it('describes an account or purchase record for welcome, receipt and transactional mail', () => {
    expect(renderDraft({ ...input, signals: ['receipt'] }).body).toContain('an account or purchase record');
  });

  it.each([
    ['unverified', renderDraft(input)],
    ['verified', renderDraft(input, verified)],
  ])('passes the banned-word lint and contains no legal-demand language (%s)', (_label, draft) => {
    const text = `${draft.subject}\n${draft.body}`;
    expect(text).not.toMatch(BANNED_WORDS);
    for (const [label, re] of LEGAL_DEMAND_PHRASES) expect(text, label).not.toMatch(re);
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  describe('the statute wording is gated by one flag', () => {
    it('shows one [OPEN] paragraph, and no section number or date anywhere else, while unverified', () => {
      expect(STATUTE_CITATION.verified).toBe(false);
      const lines = d.body.split('\n');
      const marker = lines.filter((l) => l.startsWith('[OPEN'));
      expect(marker).toHaveLength(1);
      expect(marker[0]).toContain('statute citation and commencement date pending verification');
      expect(marker[0]).toContain('Section 12(3)');
      expect(marker[0]).toContain('Section 11(1)');
      const rest = lines.filter((l) => !l.startsWith('[OPEN')).join('\n');
      expect(rest).not.toMatch(/Section \d|2027|Digital Personal Data|\bAct\b/);
      expect(findSafetyIssues(d.body)).toEqual(['open_placeholder']);
    });

    it('uses the verified sentences, and no marker, once the flag is set', () => {
      const v = renderDraft(input, verified);
      expect(v.body).toContain('Section 12(3) of the Digital Personal Data Protection Act, 2023');
      expect(v.body).toContain('Section 11(1) of the Act');
      expect(v.body).toContain('notified to come into force in May 2027, so I am making this as a request now');
      expect(v.body).not.toContain('[OPEN');
      expect(findSafetyIssues(v.subject, v.body)).toEqual([]);
    });

    it('states the commencement as a reason this is a request, not as a duty on the company', () => {
      const v = renderDraft(input, verified);
      const sentence = v.body.split('\n').find((l) => l.includes('May 2027')) ?? '';
      expect(sentence).toMatch(/so I am making this as a request now/);
      expect(sentence).not.toMatch(/\b(must|required|obliged)\b/i);
    });

    it('gates the date with the citation: a citation set verified is the only way either appears', () => {
      const partial = renderDraft(input, { ...STATUTE_CITATION, verified: false, erasureLine: 'Section 12(3) is cited here', commencementLine: 'In May 2027 it starts' });
      expect(partial.body).not.toContain('Section 12(3) is cited here');
      expect(partial.body).not.toContain('In May 2027 it starts');
    });
  });

  it('changes only the closing line for a web form, and stays free of legal-demand language', () => {
    const email = renderDraft(input, verified);
    const form = renderDraft({ ...input, channel: 'web_form' }, verified);
    expect(form.body).toContain('I am submitting this through your web form. Please reply to the email address above.');
    expect(form.body).not.toContain('I am sending this from the email address above');
    expect(form.body.replace('I am submitting this through your web form. Please reply to the email address above.', '')).toBe(
      email.body.replace('I am sending this from the email address above. Please reply to it.', ''),
    );
    for (const [label, re] of LEGAL_DEMAND_PHRASES) expect(form.body, label).not.toMatch(re);
  });

  it('never carries an ID number', () => {
    expect(findSafetyIssues(d.subject, d.body).filter((f) => f !== 'open_placeholder')).toEqual([]);
  });

  it('keeps line breaks and control characters out of the name, email and company', () => {
    const odd = renderDraft({ userName: 'Asha\r\nBcc: x@example.test', userEmail: 'a@example.test\n', companyName: 'Shop\u0000 Co', signals: [] });
    expect(odd.body).toContain('Name: Asha Bcc: x@example.test');
    expect(odd.body.includes('\u0000')).toBe(false);
  });
});

describe('hashDraft', () => {
  const base = { to: 'privacy@example.com', subject: 'S', body: 'Line one\nLine two' };

  it('is a sha256 hex string and stable', () => {
    expect(isDraftHash(hashDraft(base))).toBe(true);
    expect(hashDraft(base)).toBe(hashDraft({ ...base }));
  });

  it('changes when any of recipient, subject or body changes', () => {
    const h = hashDraft(base);
    expect(hashDraft({ ...base, to: 'other@example.com' })).not.toBe(h);
    expect(hashDraft({ ...base, subject: 'S2' })).not.toBe(h);
    expect(hashDraft({ ...base, body: `${base.body} ` })).not.toBe(h);
  });

  it('ignores the line-ending style, so a browser CRLF cannot change it', () => {
    expect(hashDraft({ ...base, body: 'Line one\r\nLine two' })).toBe(hashDraft(base));
  });

  it('does not let fields run together', () => {
    expect(hashDraft({ to: 'a', subject: 'bc', body: 'd' })).not.toBe(hashDraft({ to: 'ab', subject: 'c', body: 'd' }));
  });
});
