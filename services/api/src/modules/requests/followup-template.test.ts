import { describe, expect, it } from 'vitest';
import { BANNED_WORDS, LEGAL_DEMAND_PHRASES } from '../../../test/wording.js';
import { STATUTE_CITATION } from './draft-citation.js';
import { findSafetyIssues } from './draft-safety.js';
import { SUBJECT } from './draft-template.js';
import { FOLLOWUP_SUBJECT, FOLLOWUP_WORDING, renderFollowup } from './followup-template.js';

const input = {
  userName: 'Asha Rao',
  userEmail: 'asha@example.test',
  companyName: 'Sample Shop',
  signals: ['welcome', 'receipt'],
  sentAt: new Date('2026-11-14T09:30:00Z'),
};
const verified = { ...STATUTE_CITATION, verified: true };

/** Extra things a follow-up must not say: that a deadline passed, that time ran out, or that anything is overdue. */
const FOLLOWUP_EXTRA_PHRASES: Array<[string, RegExp]> = [
  ['a missed deadline', /\boverdue\b|\bdeadline\b|\btime ?limit\b|\bexpired\b|\bhave not (yet )?(complied|responded in time)\b|\bpast (the|your) (time|date)\b|\bno longer (waiting|willing)\b/i],
  ['days having passed as a fault', /\b\d+ days? (have|has) (passed|elapsed)\b|\bdays? (late|ago)\b.*\b(you|your)\b|\bfailed to\b|\bignored\b|\bignoring\b/i],
  ['a promise or prediction of what the company does', /\byou (will|shall)\b|\bwill (be )?(deleted|erased)\b|\bwithin \d+ days\b/i],
  ['threats and escalation', /\bescalat|\breport (you|this) to\b|\bregulator\b|\bboard\b|\bauthorit/i],
];

describe('renderFollowup', () => {
  const email = renderFollowup(input);

  it('keeps the first message’s subject so the reply stays in the same conversation', () => {
    expect(FOLLOWUP_SUBJECT).toBe(`Re: ${SUBJECT}`);
    expect(email.subject).toBe(FOLLOWUP_SUBJECT);
  });

  it('says when the first message was sent, and that no reply has been seen yet, without blaming anyone', () => {
    expect(email.body).toContain('I am following up on my email of 14 November 2026');
    expect(email.body).toContain('I have not seen a reply yet. Messages can go astray, so I am writing again in case it did not reach the right person.');
  });

  it('names the person and the registered email, and repeats the request as a request', () => {
    expect(email.body).toContain('Name: Asha Rao');
    expect(email.body).toContain('Email address: asha@example.test');
    expect(email.body).toContain('My request is the same as before: I would like to ask Sample Shop to erase the personal data it holds about me. I would be grateful for a reply, even a short one');
  });

  it('asks only for a reply: whether it was received, what happened or when to expect an answer, and what is needed to confirm identity', () => {
    expect(email.body).toContain('1. whether you received my first message;');
    expect(email.body).toContain('2. whether the data has been erased, or when you expect to be able to tell me; and');
    expect(email.body).toContain('3. if you need anything from me to confirm who I am, what you need.');
  });

  it('leaves room for the answer having already been sent, and thanks the company', () => {
    expect(email.body).toContain('If you have already replied, thank you. Please point me to your answer, as I may have missed it.');
    expect(email.body).toMatch(/Thank you for your time\.\nAsha Rao$/);
  });

  it('uses hedged wording for what the company holds (PRD 4.4)', () => {
    expect(email.body).toMatch(/that Sample Shop likely holds about me/);
    expect(renderFollowup({ ...input, signals: ['newsletter'] }).body).toMatch(/that Sample Shop may hold about me/);
  });

  it('says it is also made under any erasure process in the privacy policy, generically', () => {
    expect(email.body).toContain('I am also making this request under any erasure process described in your privacy policy.');
  });

  it.each([
    ['unverified, email', renderFollowup(input)],
    ['verified, email', renderFollowup(input, verified)],
    ['unverified, web form', renderFollowup({ ...input, channel: 'web_form' })],
    ['verified, web form', renderFollowup({ ...input, channel: 'web_form' }, verified)],
  ])('contains no banned word and no legal-demand, deadline, accusation or promise language (%s)', (_label, draft) => {
    const text = `${draft.subject}\n${draft.body}`;
    expect(text).not.toMatch(BANNED_WORDS);
    for (const [label, re] of LEGAL_DEMAND_PHRASES) expect(text, label).not.toMatch(re);
    for (const [label, re] of FOLLOWUP_EXTRA_PHRASES) expect(text, label).not.toMatch(re);
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(text).not.toMatch(/within 30 days/i); // the first message hopes for a reply in 30 days; the follow-up puts no time on it
  });

  describe('the statute wording stays behind STATUTE_CITATION.verified, like the first request', () => {
    it('carries one [OPEN] paragraph and no section number or date anywhere else while it is unverified', () => {
      expect(STATUTE_CITATION.verified).toBe(false);
      const lines = email.body.split('\n');
      const marker = lines.filter((l) => l.startsWith('[OPEN'));
      expect(marker).toHaveLength(1);
      expect(marker[0]).toContain('Section 12(3)');
      expect(marker[0]).toContain('Section 11(1)');
      const rest = lines.filter((l) => !l.startsWith('[OPEN')).join('\n');
      expect(rest).not.toMatch(/Section \d|2027|Digital Personal Data|\bAct\b/);
      expect(findSafetyIssues(email.body)).toEqual(['open_placeholder']);
    });

    it('uses the verified sentences, and no marker, once the flag is set', () => {
      const v = renderFollowup(input, verified);
      expect(v.body).toContain('Section 12(3) of the Digital Personal Data Protection Act, 2023');
      expect(v.body).toContain('My earlier request for a summary refers to Section 11(1) of the Act.');
      expect(v.body).not.toContain('My request for a summary'); // the follow-up asks only for erasure
      expect(v.body).toContain('so I am making this as a request now');
      expect(v.body).not.toContain('[OPEN');
      expect(findSafetyIssues(v.subject, v.body)).toEqual([]);
    });

    it('a citation that is not marked verified never shows its sentences', () => {
      const partial = renderFollowup(input, { ...STATUTE_CITATION, verified: false, erasureLine: 'Section 12(3) is cited here', commencementLine: 'In May 2027 it starts' });
      expect(partial.body).not.toContain('Section 12(3) is cited here');
      expect(partial.body).not.toContain('In May 2027 it starts');
    });
  });

  it('changes only the opening reference and the closing line for a web form', () => {
    const form = renderFollowup({ ...input, channel: 'web_form' }, verified);
    expect(form.body).toContain('I am following up on my request through your web form on 14 November 2026');
    expect(form.body).toContain('I am submitting this through your web form. Please reply to the email address above.');
    expect(form.body).not.toContain('I am sending this from the email address above');
    const normalise = (b: string) =>
      b
        .replace('my request through your web form on 14 November 2026', 'X')
        .replace('my email of 14 November 2026', 'X')
        .replace('I am submitting this through your web form. Please reply to the email address above.', 'Y')
        .replace('I am sending this from the email address above. Please reply to it.', 'Y');
    expect(normalise(form.body)).toBe(normalise(renderFollowup(input, verified).body));
  });

  it('never carries an ID number', () => {
    expect(findSafetyIssues(email.subject, email.body).filter((f) => f !== 'open_placeholder')).toEqual([]);
  });

  it('keeps line breaks and control characters out of the name, email and company', () => {
    const odd = renderFollowup({ ...input, userName: 'Asha\r\nBcc: x@example.test', userEmail: 'a@example.test\n', companyName: 'Shop\u0000 Co', signals: [] });
    expect(odd.body).toContain('Name: Asha Bcc: x@example.test');
    expect(odd.body.includes('\u0000')).toBe(false);
  });

  it('formats the date in UTC, so the same message reads the same wherever it is drafted', () => {
    expect(renderFollowup({ ...input, sentAt: new Date('2026-12-31T23:30:00Z') }).body).toContain('my email of 31 December 2026');
  });
});

describe('the follow-up wording sign-off', () => {
  it('is off until the owner has read the wording and changed it in code', () => {
    expect(FOLLOWUP_WORDING.signedOff).toBe(false);
  });
});
