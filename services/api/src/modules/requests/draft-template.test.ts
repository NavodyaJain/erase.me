import { describe, expect, it } from 'vitest';
import { findSafetyIssues } from './draft-safety.js';
import { STATUTE_CITATION } from './draft-citation.js';
import { hashDraft, isDraftHash } from './draft-hash.js';
import { renderDraft, SUBJECT } from './draft-template.js';

const input = { userName: 'Asha Rao', userEmail: 'asha@example.test', companyName: 'Sample Shop', signals: ['welcome', 'list_unsubscribe'] };

describe('renderDraft', () => {
  const d = renderDraft(input);

  it('names the user and registered email, asks for a written answer within 30 days', () => {
    expect(d.subject).toBe(SUBJECT);
    expect(d.body).toContain('Name: Asha Rao');
    expect(d.body).toContain('Email address: asha@example.test');
    expect(d.body).toMatch(/reply in writing within 30 days/);
    expect(d.body).toMatch(/what you keep, why, and for how long/);
  });

  it('uses hedged wording, never a promise, a threat or a legal conclusion (PRD 4.4)', () => {
    expect(d.body).toMatch(/likely holds/);
    expect(d.body).not.toMatch(/will delete|guarantee|leaked|your data is safe|compliant|illegal|violat|sue|court|penalt|fine\b|!/i);
    expect(d.body).not.toMatch(/\b(you must|you are required|breach)\b/i);
  });

  it('says "may hold" when only mailing-list headers were seen', () => {
    const low = renderDraft({ ...input, signals: ['newsletter'] });
    expect(low.body).toMatch(/may hold/);
    expect(low.body).not.toMatch(/likely holds/);
    expect(low.body).toContain('my email address on a mailing list');
  });

  it('describes an account or purchase record for welcome, receipt and transactional mail', () => {
    expect(renderDraft({ ...input, signals: ['receipt'] }).body).toContain('an account or purchase record');
  });

  it('carries a visible [OPEN] marker, with the candidate, while the citation is unverified', () => {
    expect(STATUTE_CITATION.verified).toBe(false);
    expect(d.body).toContain('[OPEN: statute citation pending verification.');
    expect(d.body).toContain(STATUTE_CITATION.candidate);
    expect(findSafetyIssues(d.body)).toEqual(['open_placeholder']);
  });

  it('uses the citation line once it is verified, with no marker left', () => {
    const verified = renderDraft(input, { ...STATUTE_CITATION, verified: true });
    expect(verified.body).toContain(STATUTE_CITATION.line);
    expect(verified.body).not.toContain('[OPEN');
    expect(findSafetyIssues(verified.subject, verified.body)).toEqual([]);
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
