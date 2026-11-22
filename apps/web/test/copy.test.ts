// banned-words:ignore-file  (this test feeds banned phrases to the wording rules to prove they are caught)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy/en';
import { AUTH_ERROR_MESSAGES, describeError, ERROR_MESSAGES } from '@/copy/errors';
import { ApiError } from '@erase/api-client';
import { findViolations, stringsIn } from './banned';

const root = path.resolve(__dirname, '..');

describe('the wording rules themselves', () => {
  it('catch the banned wording and let hedged wording through', () => {
    const rules = (t: string) => findViolations(t).map((v) => v.rule);
    expect(rules('We will delete your data')).toContain('will-delete');
    expect(rules('Guaranteed to work')).toContain('guaranteed');
    expect(rules('This is not guaranteed')).toEqual([]);
    expect(rules('A compliant company')).toContain('compliant');
    expect(rules('Your data is safe with us')).toContain('data-safe');
    expect(rules('This company leaked your email')).toContain('leaked');
    expect(rules('This company may have leaked your email')).toEqual([]);
    expect(rules('Great news!')).toContain('exclamation');
    expect(rules('likely holds, may hold, looks unused')).toEqual([]);
  });
});

describe('copy module', () => {
  it('has no banned wording in any string', () => {
    const bad = stringsIn(copy).flatMap((s) => findViolations(s).map((v) => `${v.rule}: "${s}"`));
    expect(bad).toEqual([]);
  });

  it('uses the hedged labels the design asks for', () => {
    expect(copy.labels.confidence).toEqual({ high: 'Likely', low: 'Possible' });
    expect(copy.labels.activity).toEqual({ looks_in_use: 'Looks in use', looks_unused: 'Looks unused' });
  });
});

describe('error messages', () => {
  const spec = JSON.parse(readFileSync(path.resolve(root, '../../services/api/openapi/openapi.json'), 'utf8')) as {
    components: { schemas: { Problem: { properties: { code: { enum: string[] } } } } };
  };
  const apiCodes = spec.components.schemas.Problem.properties.code.enum;

  it('has a message for every error code in the API contract', () => {
    expect(apiCodes.length).toBeGreaterThan(30);
    const missing = apiCodes.filter((c) => !(c in ERROR_MESSAGES));
    expect(missing).toEqual([]);
    for (const code of apiCodes) expect(ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES].length, code).toBeGreaterThan(10);
  });

  it('has no banned wording and makes no promise about deletion', () => {
    for (const [code, message] of [...Object.entries(ERROR_MESSAGES), ...Object.entries(AUTH_ERROR_MESSAGES)]) {
      expect(findViolations(message), `${code}: ${message}`).toEqual([]);
    }
    expect(ERROR_MESSAGES.must_keep).toMatch(/does not offer a deletion request/);
    expect(ERROR_MESSAGES.must_keep).not.toMatch(/will|guarantee|confirm/i);
  });

  it('says what the person has to do for the codes that need care', () => {
    expect(ERROR_MESSAGES.draft_changed).toMatch(/Review the latest version/);
    expect(ERROR_MESSAGES.send_outcome_unknown).toMatch(/Sent folder in Gmail/);
    expect(ERROR_MESSAGES.send_outcome_unknown).toMatch(/does not retry it on its own/);
    expect(ERROR_MESSAGES.use_form).toMatch(/web form/);
    expect(ERROR_MESSAGES.kept).toMatch(/Keep this/);
    expect(ERROR_MESSAGES.real_send_blocked).toMatch(/still edit and approve/);
  });

  it('shows our message, never a sentence the server supplied', () => {
    const err = new ApiError(409, 'draft_changed', 'Title from server', 'A server sentence with draft text and person@example.com', 'req-1', {});
    const shown = describeError(err);
    expect(shown).toEqual({ code: 'draft_changed', message: ERROR_MESSAGES.draft_changed });
    expect(shown.message).not.toContain('person@example.com');
    expect(describeError(new Error('boom')).code).toBe('network_error');
    expect(describeError(new ApiError(500, 'brand_new_code' as never, 't', undefined, undefined, {})).message).toBe(ERROR_MESSAGES.unreadable_response);
  });
});

describe('source files', () => {
  /** Source text without comments, so wording rules apply to what a person can read and not to developer notes. */
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(path.join(root, 'src'));

  it('contain no banned wording in code or JSX text', () => {
    expect(files.length).toBeGreaterThan(10);
    const bad = files.flatMap((f) =>
      findViolations(strip(readFileSync(f, 'utf8')))
        .filter((v) => v.rule !== 'exclamation') // `!` is also JavaScript: checked on strings above
        .map((v) => `${path.relative(root, f)} ${v.rule}: ${v.context}`),
    );
    expect(bad).toEqual([]);
  });
});
