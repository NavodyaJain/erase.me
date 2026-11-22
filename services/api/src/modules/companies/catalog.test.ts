import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog, parseCatalog } from './catalog.js';

const entry = (over: Record<string, unknown> = {}) => ({
  slug: 'brand',
  name: 'Brand',
  domains: ['brand.example'],
  category: 'saas',
  ...over,
});
const file = (...companies: unknown[]) => JSON.stringify({ version: 1, companies });

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'erase-catalog-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('the committed catalog', () => {
  const all = loadCatalog({ includeFictional: true });

  it('is valid and has no domain claimed twice', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it('marks Google as must-keep with no grievance contact (item 5)', () => {
    const google = all.find((e) => e.slug === 'google');
    expect(google).toMatchObject({ name: 'Google', must_keep: true, category: 'account_provider' });
    expect(google?.grievance).toBeUndefined();
    expect(google?.domains).toContain('google.com');
  });

  it('accepts the account_provider and games categories', () => {
    expect(parseCatalog(file(entry({ category: 'games' })), 'x')[0]?.category).toBe('games');
    expect(parseCatalog(file(entry({ category: 'account_provider' })), 'x')[0]?.category).toBe('account_provider');
  });

  it('maps the Happn domains to a proper name (item 2)', () => {
    const happn = all.find((e) => e.slug === 'happn');
    expect(happn?.name).toBe('Happn');
    expect(happn?.domains).toEqual(expect.arrayContaining(['happn.com', 'happnmail.com']));
  });

  it('keeps fictional entries on @example.com and out of production', () => {
    const fictional = all.filter((e) => e.fictional);
    expect(fictional.length).toBeGreaterThan(0);
    for (const e of fictional) {
      const g = e.grievance;
      if (g?.channel === 'email') expect(g.email).toMatch(/@example\.com$/);
      if (g?.channel === 'web_form') expect(g.form_url).toMatch(/^https:\/\/example\.com\//);
    }
    expect(loadCatalog({ includeFictional: false }).some((e) => e.fictional)).toBe(false);
  });

  it('gives every real contact a source page and verification date', () => {
    for (const e of all.filter((x) => !x.fictional && x.grievance)) {
      expect(e.grievance?.source_url).toMatch(/^https:\/\//);
      expect(e.grievance?.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('parseCatalog', () => {
  it('accepts a minimal entry and defaults must_keep and fictional to false', () => {
    expect(parseCatalog(file(entry()), 'x')[0]).toMatchObject({ must_keep: false, fictional: false });
  });

  it.each([
    ['a bad slug', entry({ slug: 'Bad Slug' })],
    ['no domains', entry({ domains: [] })],
    ['a bad domain', entry({ domains: ['not a domain'] })],
    ['an unknown category', entry({ category: 'banking' })],
    ['a contact without a source', entry({ grievance: { email: 'a@brand.example', verified_on: '2026-01-01' } })],
    ['a contact without a date', entry({ grievance: { email: 'a@brand.example', source_url: 'https://brand.example/privacy' } })],
    ['a real entry on @example.com', entry({ grievance: { email: 'a@example.com', source_url: 'https://brand.example/p', verified_on: '2026-01-01' } })],
    ['a fictional entry on a real address', entry({ fictional: true, grievance: { email: 'a@brand.example', source_url: 'https://brand.example/p', verified_on: '2026-01-01' } })],
    ['a must-keep company with a contact', entry({ must_keep: true, grievance: { email: 'a@brand.example', source_url: 'https://brand.example/p', verified_on: '2026-01-01' } })],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseCatalog(file(bad), 'x')).toThrow(/Invalid catalog/);
  });

  it('reports field paths, never the offending values', () => {
    let message = '';
    try {
      parseCatalog(file(entry({ domains: ['secret value here'] })), 'x');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/companies\.0\.domains/);
    expect(message).not.toContain('secret value here');
  });
});

describe('loadCatalog', () => {
  it('merges catalog.local.json over the committed file, and works without it', () => {
    const base = file(entry({ slug: 'one', name: 'One', domains: ['one.example'] }), entry({ slug: 'two', name: 'Two', domains: ['two.example'] }));
    const local = file(entry({ slug: 'two', name: 'Two Renamed', domains: ['two.example'] }), entry({ slug: 'three', name: 'Three', domains: ['three.example'] }));
    expect(loadCatalog({ dir: dirWith({ 'catalog.json': base }), includeFictional: true }).map((e) => e.name)).toEqual(['One', 'Two']);
    const merged = loadCatalog({ dir: dirWith({ 'catalog.json': base, 'catalog.local.json': local }), includeFictional: true });
    expect(merged.map((e) => e.name).sort()).toEqual(['One', 'Three', 'Two Renamed']);
  });

  it('refuses a domain claimed by two companies', () => {
    const dir = dirWith({ 'catalog.json': file(entry({ slug: 'a', domains: ['same.example'] }), entry({ slug: 'b', domains: ['same.example'] })) });
    expect(() => loadCatalog({ dir, includeFictional: true })).toThrow(/claimed by two/);
  });
});

describe('contact channels and the self-serve link', () => {
  const form = { channel: 'web_form', form_url: 'https://brand.example/privacy/request', source_url: 'https://brand.example/privacy', verified_on: '2026-01-01' };
  const email = { email: 'privacy@brand.example', source_url: 'https://brand.example/privacy', verified_on: '2026-01-01' };

  it('treats a contact without a channel as email, and accepts a web form', () => {
    expect(parseCatalog(file(entry({ grievance: email })), 'x')[0]?.grievance).toMatchObject({ channel: 'email', email: 'privacy@brand.example' });
    expect(parseCatalog(file(entry({ grievance: form })), 'x')[0]?.grievance).toMatchObject({ channel: 'web_form', form_url: 'https://brand.example/privacy/request' });
  });

  it.each([
    ['a form without a form URL', { channel: 'web_form', source_url: form.source_url, verified_on: form.verified_on }],
    ['a form without a source page', { channel: 'web_form', form_url: form.form_url, verified_on: form.verified_on }],
    ['a form without a date', { channel: 'web_form', form_url: form.form_url, source_url: form.source_url }],
    ['a form with an email address too', { ...form, email: 'privacy@brand.example' }],
    ['an email contact with a form URL too', { ...email, form_url: form.form_url }],
    ['a form on http', { ...form, form_url: 'http://brand.example/form' }],
    ['a form that is not a URL', { ...form, form_url: 'not a url' }],
    ['an unknown channel', { ...email, channel: 'fax' }],
  ])('rejects %s', (_label, grievance) => {
    expect(() => parseCatalog(file(entry({ grievance })), 'x')).toThrow(/Invalid catalog/);
  });

  it('keeps fictional forms and links on example.com and example.com out of real entries', () => {
    const fictionalForm = { ...form, form_url: 'https://example.com/request', source_url: 'https://example.com/privacy' };
    expect(parseCatalog(file(entry({ fictional: true, grievance: fictionalForm, self_serve_url: 'https://example.com/delete' })), 'x')).toHaveLength(1);
    expect(() => parseCatalog(file(entry({ fictional: true, grievance: form })), 'x')).toThrow(/example\.com/);
    expect(() => parseCatalog(file(entry({ grievance: fictionalForm })), 'x')).toThrow(/fictional entries only/);
    expect(() => parseCatalog(file(entry({ fictional: true, self_serve_url: 'https://brand.example/delete' })), 'x')).toThrow(/example\.com/);
    expect(() => parseCatalog(file(entry({ self_serve_url: 'https://example.com/delete' })), 'x')).toThrow(/fictional entries only/);
  });

  it('accepts an optional self-serve URL, only over https', () => {
    expect(parseCatalog(file(entry({ self_serve_url: 'https://brand.example/account/delete' })), 'x')[0]?.self_serve_url).toBe('https://brand.example/account/delete');
    expect(parseCatalog(file(entry()), 'x')[0]?.self_serve_url).toBeUndefined();
    expect(() => parseCatalog(file(entry({ self_serve_url: 'http://brand.example/delete' })), 'x')).toThrow(/https/);
  });

  it('gives a must-keep company neither a contact nor a self-serve deletion link', () => {
    expect(() => parseCatalog(file(entry({ must_keep: true, self_serve_url: 'https://brand.example/delete' })), 'x')).toThrow(/no self-serve deletion link/);
    expect(() => parseCatalog(file(entry({ must_keep: true, grievance: form })), 'x')).toThrow(/no grievance contact/);
  });

  it('carries one fictional web form and one fictional self-serve link, and no real contact or link', () => {
    const all = loadCatalog({ includeFictional: true });
    expect(all.some((e) => e.fictional && e.grievance?.channel === 'web_form')).toBe(true);
    expect(all.some((e) => e.fictional && e.self_serve_url)).toBe(true);
    for (const e of all.filter((x) => !x.fictional)) {
      expect(e.grievance, e.slug).toBeUndefined();
      expect(e.self_serve_url, e.slug).toBeUndefined();
    }
  });
});
