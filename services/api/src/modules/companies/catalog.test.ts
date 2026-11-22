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
    expect(google).toMatchObject({ name: 'Google', must_keep: true });
    expect(google?.grievance).toBeUndefined();
    expect(google?.domains).toContain('google.com');
  });

  it('maps the Happn domains to a proper name (item 2)', () => {
    const happn = all.find((e) => e.slug === 'happn');
    expect(happn?.name).toBe('Happn');
    expect(happn?.domains).toEqual(expect.arrayContaining(['happn.com', 'happnmail.com']));
  });

  it('keeps fictional entries on @example.com and out of production', () => {
    const fictional = all.filter((e) => e.fictional);
    expect(fictional.length).toBeGreaterThan(0);
    for (const e of fictional) expect(e.grievance?.email).toMatch(/@example\.com$/);
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
