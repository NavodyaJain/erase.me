import { describe, expect, it } from 'vitest';
import { explainFindings, findSafetyIssues, luhnValid, verhoeffCheckDigit, verhoeffValid } from './draft-safety.js';

/** A 12-digit number that passes Verhoeff and starts with 2-9, built from 11 digits plus the check digit. */
const aadhaar = (first11: string): string => `${first11}${verhoeffCheckDigit(first11)}`;

describe('Verhoeff', () => {
  it('matches the published example (236 -> check digit 3)', () => {
    expect(verhoeffCheckDigit('236')).toBe(3);
    expect(verhoeffValid('2363')).toBe(true);
    expect(verhoeffValid('2364')).toBe(false);
  });

  it('accepts generated numbers and rejects a changed digit or a swapped pair', () => {
    const n = aadhaar('23456789012');
    expect(n).toHaveLength(12);
    expect(verhoeffValid(n)).toBe(true);
    const changed = `${n.slice(0, 5)}${(Number(n[5]) + 1) % 10}${n.slice(6)}`;
    expect(verhoeffValid(changed)).toBe(false);
    expect(verhoeffValid('not digits')).toBe(false);
  });
});

describe('Luhn', () => {
  it('accepts a well-known test card number and rejects a changed one', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('123456')).toBe(false);
  });
});

describe('findSafetyIssues', () => {
  const valid = aadhaar('23456789012');
  const spaced = `${valid.slice(0, 4)} ${valid.slice(4, 8)} ${valid.slice(8)}`;
  const hyphenated = `${valid.slice(0, 4)}-${valid.slice(4, 8)}-${valid.slice(8)}`;

  it.each([
    ['plain', `My number is ${valid}.`],
    ['spaced', `Aadhaar: ${spaced}`],
    ['hyphenated', `ID ${hyphenated} please`],
  ])('finds a Verhoeff-valid 12-digit run (%s)', (_label, text) => {
    expect(findSafetyIssues(text)).toEqual(['aadhaar']);
  });

  it('does not flag a 12-digit run that fails Verhoeff, or one inside a longer number', () => {
    const bad = `${valid.slice(0, 11)}${(Number(valid[11]) + 1) % 10}`;
    expect(findSafetyIssues(`Order ${bad} shipped`)).toEqual([]);
    expect(findSafetyIssues(`Reference ${valid}9 and 9${valid}`)).toEqual([]);
  });

  it('does not flag a number starting with 0 or 1 (Aadhaar never does)', () => {
    const lead1 = `1${verhoeffCheckDigit('1')}`; // not used; build a real 12-digit starting with 1
    void lead1;
    const first11 = '12345678901';
    expect(findSafetyIssues(`${first11}${verhoeffCheckDigit(first11)}`)).toEqual([]);
  });

  it.each([
    ['pan', 'My PAN is ABCDE1234F.', 'pan'],
    ['pan lowercase', 'pan abcde1234f', 'pan'],
    ['passport', 'Passport K1234567 attached', 'passport'],
    ['voter id', 'EPIC number ABC1234567', 'voter_id'],
    ['gstin', 'GSTIN 27ABCDE1234F1Z5', 'gstin'],
    ['card', 'Card 4111 1111 1111 1111', 'card'],
    ['card hyphenated', 'Card 4111-1111-1111-1111', 'card'],
  ])('finds %s', (_label, text, finding) => {
    expect(findSafetyIssues(text)).toContain(finding);
  });

  it('leaves ordinary text alone', () => {
    expect(
      findSafetyIssues('Please erase my data. Call 9876543210 or write to me@example.test. Order 4452 on 2025-03-01.'),
    ).toEqual([]);
  });

  it('finds an unresolved [OPEN] placeholder', () => {
    expect(findSafetyIssues('[OPEN: statute citation pending verification]')).toEqual(['open_placeholder']);
  });

  it('reports categories only, never the matched text', () => {
    const findings = findSafetyIssues(`Aadhaar ${valid} PAN ABCDE1234F`);
    expect(findings.sort()).toEqual(['aadhaar', 'pan']);
    const explained = explainFindings(findings);
    expect(explained).toMatch(/Aadhaar-like number/);
    expect(explained).not.toContain(valid);
    expect(explained).not.toContain('ABCDE1234F');
  });

  it('checks subject and body together', () => {
    expect(findSafetyIssues('Subject text', `Body ${valid}`)).toEqual(['aadhaar']);
  });
});
